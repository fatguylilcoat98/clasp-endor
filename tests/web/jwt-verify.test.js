'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifySupabaseJwt } = require('../../src/web/jwt-verify');

const SECRET = 'unit-test-secret-please-rotate-me';
const ANOTHER_SECRET = 'different-test-secret-of-length';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt({ alg = 'HS256', typ = 'JWT', claims = {}, secret = SECRET, badSignature = false }) {
  const header = b64urlEncode(JSON.stringify({ alg, typ }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  let sig;
  if (badSignature) {
    sig = b64urlEncode(crypto.randomBytes(32));
  } else if (alg === 'HS256') {
    sig = b64urlEncode(crypto.createHmac('sha256', secret).update(signingInput).digest());
  } else {
    sig = b64urlEncode(Buffer.alloc(32));
  }
  return `${signingInput}.${sig}`;
}

const VALID_SUB = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const NOW_MS = 1700000000000;
const NOW_SECS = Math.floor(NOW_MS / 1000);

test('valid HS256 token verifies and returns claims', () => {
  const token = makeJwt({
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://x.supabase.co/auth/v1' },
  });
  const claims = verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS });
  assert.equal(claims.sub, VALID_SUB);
});

test('expected issuer mismatch rejects', () => {
  const token = makeJwt({
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://wrong.supabase.co/auth/v1' },
  });
  assert.throws(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS, expectedIssuer: 'https://x.supabase.co/auth/v1' }),
    /invalid token/
  );
});

test('expected issuer match passes', () => {
  const token = makeJwt({
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://x.supabase.co/auth/v1' },
  });
  const claims = verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS, expectedIssuer: 'https://x.supabase.co/auth/v1' });
  assert.equal(claims.iss, 'https://x.supabase.co/auth/v1');
});

test('alg=none is rejected', () => {
  const token = makeJwt({ alg: 'none', claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('alg=RS256 is rejected (asymmetric not supported)', () => {
  const token = makeJwt({ alg: 'RS256', claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('signed with wrong secret is rejected', () => {
  const token = makeJwt({
    secret: ANOTHER_SECRET,
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
  });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('tampered signature is rejected', () => {
  const token = makeJwt({
    badSignature: true,
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
  });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('expired token is rejected', () => {
  const token = makeJwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 3600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('expired but within skew tolerance is accepted', () => {
  // Token expired 10s ago; default skew is 30s.
  const token = makeJwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 10 } });
  const claims = verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS });
  assert.equal(claims.sub, VALID_SUB);
});

test('nbf in the future is rejected', () => {
  const token = makeJwt({ claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, nbf: NOW_SECS + 600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('missing sub is rejected', () => {
  const token = makeJwt({ claims: { exp: NOW_SECS + 3600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }), /invalid token/);
});

test('malformed token (no dots) is rejected', () => {
  assert.throws(() => verifySupabaseJwt('not.a.jwt.extra.parts', { secret: SECRET }), /invalid token/);
  assert.throws(() => verifySupabaseJwt('onepart', { secret: SECRET }), /invalid token/);
});

test('empty / non-string token is rejected', () => {
  assert.throws(() => verifySupabaseJwt('', { secret: SECRET }), /invalid token/);
  assert.throws(() => verifySupabaseJwt(null, { secret: SECRET }), /invalid token/);
});

test('short secret is rejected (server misconfig)', () => {
  const token = makeJwt({ claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  assert.throws(() => verifySupabaseJwt(token, { secret: 'short' }), /secret/);
});

test('failure messages are uniform and non-enumerating', () => {
  // Same error string for: wrong signature, wrong alg, wrong secret,
  // expired, missing sub. Attackers cannot probe to distinguish.
  const wrong = makeJwt({ secret: ANOTHER_SECRET, claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  const expired = makeJwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 3600 } });
  const noSub = makeJwt({ claims: { exp: NOW_SECS + 3600 } });
  const none = makeJwt({ alg: 'none', claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  const msgs = new Set();
  for (const t of [wrong, expired, noSub, none, 'malformed']) {
    try { verifySupabaseJwt(t, { secret: SECRET, nowMs: NOW_MS }); } catch (e) { msgs.add(e.message); }
  }
  assert.equal(msgs.size, 1, `expected one uniform message; got: ${Array.from(msgs).join(' | ')}`);
});
