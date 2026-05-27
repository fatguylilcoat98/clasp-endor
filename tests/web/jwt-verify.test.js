'use strict';

/*
 * JWT verification tests — covers all three algorithms the verifier
 * accepts (HS256 + RS256 + ES256). The HS256 path uses the legacy
 * Supabase shared secret. The RS256 / ES256 paths use a JWKS-style
 * getKey(kid) callback that returns a JWK object; in production this
 * is wired to src/web/jwks-client.js, which fetches and caches
 * Supabase's JWKS endpoint.
 *
 * verifySupabaseJwt is async. All assertions use assert.rejects /
 * await accordingly.
 */

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

function makeHs256Jwt({ typ = 'JWT', claims = {}, secret = SECRET, badSignature = false } = {}) {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  let sig;
  if (badSignature) {
    sig = b64urlEncode(crypto.randomBytes(32));
  } else {
    sig = b64urlEncode(crypto.createHmac('sha256', secret).update(signingInput).digest());
  }
  return `${signingInput}.${sig}`;
}

// Generate an ES256 (P-256) key pair once for the asymmetric tests.
// JWK extraction lets us return the public half via a getKey() seam.
function generateEs256Keys(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }), {
    kid,
    use: 'sig',
    alg: 'ES256',
  });
  return { privateKey, publicJwk: jwk };
}

function generateRs256Keys(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign({}, publicKey.export({ format: 'jwk' }), {
    kid,
    use: 'sig',
    alg: 'RS256',
  });
  return { privateKey, publicJwk: jwk };
}

function signEs256({ kid, claims, privateKey }) {
  const header = b64urlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign(
    'SHA256',
    Buffer.from(signingInput, 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

function signRs256({ kid, claims, privateKey }) {
  const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    privateKey
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

const VALID_SUB = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const NOW_MS = 1700000000000;
const NOW_SECS = Math.floor(NOW_MS / 1000);

// =====================================================================
// HS256 (legacy Supabase shared secret)
// =====================================================================

test('HS256: valid token verifies and returns claims', async () => {
  const token = makeHs256Jwt({
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://x.supabase.co/auth/v1' },
  });
  const claims = await verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS });
  assert.equal(claims.sub, VALID_SUB);
});

test('HS256: expected issuer mismatch rejects', async () => {
  const token = makeHs256Jwt({
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://wrong.supabase.co/auth/v1' },
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS, expectedIssuer: 'https://x.supabase.co/auth/v1' }),
    /invalid token/
  );
});

test('HS256: signed with wrong secret is rejected', async () => {
  const token = makeHs256Jwt({
    secret: ANOTHER_SECRET,
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('HS256: tampered signature is rejected', async () => {
  const token = makeHs256Jwt({
    badSignature: true,
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('HS256: expired token is rejected', async () => {
  const token = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 3600 } });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('HS256: expired but within skew tolerance is accepted', async () => {
  const token = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 10 } });
  const claims = await verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS });
  assert.equal(claims.sub, VALID_SUB);
});

test('HS256: nbf in the future is rejected', async () => {
  const token = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, nbf: NOW_SECS + 600 } });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('HS256: missing sub is rejected', async () => {
  const token = makeHs256Jwt({ claims: { exp: NOW_SECS + 3600 } });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

// =====================================================================
// ES256 (Supabase asymmetric JWT signing keys — the new default)
// =====================================================================

test('ES256: valid token verifies through getKey(kid) lookup', async () => {
  const { privateKey, publicJwk } = generateEs256Keys('key-es-1');
  const token = signEs256({
    kid: 'key-es-1',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://x.supabase.co/auth/v1' },
    privateKey,
  });
  const calls = [];
  const getKey = (kid) => { calls.push(kid); return publicJwk; };
  const claims = await verifySupabaseJwt(token, {
    secret: SECRET,
    getKey,
    nowMs: NOW_MS,
    expectedIssuer: 'https://x.supabase.co/auth/v1',
  });
  assert.equal(claims.sub, VALID_SUB);
  assert.deepEqual(calls, ['key-es-1']);
});

test('ES256: signed by attacker key (wrong key returned by getKey) is rejected', async () => {
  // The signer uses one key, getKey returns a DIFFERENT public key
  // for the same kid — the signature verification must fail.
  const { privateKey } = generateEs256Keys('key-es-2');
  const { publicJwk: wrongPublic } = generateEs256Keys('key-es-2');
  const token = signEs256({
    kid: 'key-es-2',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, getKey: () => wrongPublic, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('ES256: token with no kid in header is rejected', async () => {
  // Forge a header without kid.
  const header = b64urlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify({ sub: VALID_SUB, exp: NOW_SECS + 3600 }));
  const token = `${header}.${payload}.${b64urlEncode(crypto.randomBytes(64))}`;
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, getKey: () => ({}), nowMs: NOW_MS }),
    /invalid token/
  );
});

test('ES256: getKey returning null (unknown kid after refetch) is rejected', async () => {
  const { privateKey } = generateEs256Keys('key-missing');
  const token = signEs256({
    kid: 'key-missing',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, getKey: () => null, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('ES256: getKey throwing is rejected (does not leak)', async () => {
  const { privateKey } = generateEs256Keys('key-throw');
  const token = signEs256({
    kid: 'key-throw',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, {
      secret: SECRET,
      getKey: () => { throw new Error('jwks endpoint exploded'); },
      nowMs: NOW_MS,
    }),
    /invalid token/
  );
});

test('ES256: no getKey provided is rejected (caller misconfig)', async () => {
  const { privateKey } = generateEs256Keys('key-no-callback');
  const token = signEs256({
    kid: 'key-no-callback',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

// =====================================================================
// RS256 (Supabase asymmetric signing keys, RSA option)
// =====================================================================

test('RS256: valid token verifies through getKey(kid) lookup', async () => {
  const { privateKey, publicJwk } = generateRs256Keys('key-rsa-1');
  const token = signRs256({
    kid: 'key-rsa-1',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600, iss: 'https://x.supabase.co/auth/v1' },
    privateKey,
  });
  const claims = await verifySupabaseJwt(token, {
    secret: SECRET,
    getKey: () => publicJwk,
    nowMs: NOW_MS,
    expectedIssuer: 'https://x.supabase.co/auth/v1',
  });
  assert.equal(claims.sub, VALID_SUB);
});

test('RS256: tampered signature is rejected', async () => {
  const { privateKey, publicJwk } = generateRs256Keys('key-rsa-2');
  const good = signRs256({
    kid: 'key-rsa-2',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  // Replace the signature segment with random bytes of the same length.
  const parts = good.split('.');
  const badSig = b64urlEncode(crypto.randomBytes(256));
  const token = `${parts[0]}.${parts[1]}.${badSig}`;
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, getKey: () => publicJwk, nowMs: NOW_MS }),
    /invalid token/
  );
});

// =====================================================================
// Cross-alg + structural rejections
// =====================================================================

test('alg=none is rejected', async () => {
  const header = b64urlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify({ sub: VALID_SUB, exp: NOW_SECS + 3600 }));
  const token = `${header}.${payload}.`;
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('alg=HS512 (not in allowlist) is rejected', async () => {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS512', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify({ sub: VALID_SUB, exp: NOW_SECS + 3600 }));
  const token = `${header}.${payload}.${b64urlEncode(crypto.randomBytes(64))}`;
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('alg-confusion: ES256 token presented WITHOUT getKey falls back to HS256? No — rejected', async () => {
  // Defence in depth: a token claiming alg=ES256 must NOT verify against
  // the HS256 secret as a fallback. Each alg has its own verification
  // path and no automatic downgrade.
  const { privateKey } = generateEs256Keys('confuse');
  const token = signEs256({
    kid: 'confuse',
    claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 },
    privateKey,
  });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: SECRET, nowMs: NOW_MS }),
    /invalid token/
  );
});

test('alg-confusion: HS256 token cannot be reinterpreted as RS256 against an attacker-supplied JWK', async () => {
  // The classic alg-confusion attack: an attacker grabs the
  // RSA public key, then signs a token with alg=HS256 and the public
  // key bytes as the HMAC secret. Our verifier picks the path from
  // header.alg, and HS256 requires a specific secret string — there
  // is no JWK→HMAC bridge. Sanity-check by inverting: an HS256 token
  // signed with the secret does NOT verify when caller pretends it's
  // RS256 (we can't fake the header; rebuilding the header to RS256
  // breaks the signing input, which breaks the HMAC).
  const token = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  const parts = token.split('.');
  const newHeader = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'attacker' }));
  const reHeadered = `${newHeader}.${parts[1]}.${parts[2]}`;
  await assert.rejects(
    () => verifySupabaseJwt(reHeadered, {
      secret: SECRET,
      getKey: () => ({ kty: 'oct', k: 'whatever' }), // not a real RSA JWK
      nowMs: NOW_MS,
    }),
    /invalid token/
  );
});

test('malformed token (wrong segment count) is rejected', async () => {
  await assert.rejects(
    () => verifySupabaseJwt('not.a.jwt.extra.parts', { secret: SECRET }),
    /invalid token/
  );
  await assert.rejects(
    () => verifySupabaseJwt('onepart', { secret: SECRET }),
    /invalid token/
  );
});

test('empty / non-string token is rejected', async () => {
  await assert.rejects(() => verifySupabaseJwt('', { secret: SECRET }), /invalid token/);
  await assert.rejects(() => verifySupabaseJwt(null, { secret: SECRET }), /invalid token/);
});

test('HS256 with short secret is rejected (server misconfig)', async () => {
  const token = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  await assert.rejects(
    () => verifySupabaseJwt(token, { secret: 'short' }),
    /invalid token/
  );
});

test('failure messages are uniform across alg paths and failure classes', async () => {
  // Same error string for: wrong HS256 secret, expired, missing sub,
  // alg=none, malformed, ES256 with no getKey, ES256 with wrong key.
  // Attackers cannot probe to distinguish failure types.
  const { privateKey: esPriv, publicJwk: esPub } = generateEs256Keys('uniform');
  const { publicJwk: esPubWrong } = generateEs256Keys('uniform');

  const wrong = makeHs256Jwt({ secret: ANOTHER_SECRET, claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 } });
  const expired = makeHs256Jwt({ claims: { sub: VALID_SUB, exp: NOW_SECS - 3600 } });
  const noSub = makeHs256Jwt({ claims: { exp: NOW_SECS + 3600 } });
  const noneHeader = b64urlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const nonePayload = b64urlEncode(JSON.stringify({ sub: VALID_SUB, exp: NOW_SECS + 3600 }));
  const none = `${noneHeader}.${nonePayload}.`;
  const esWrong = signEs256({ kid: 'uniform', claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 }, privateKey: esPriv });
  const esNoKey = signEs256({ kid: 'uniform', claims: { sub: VALID_SUB, exp: NOW_SECS + 3600 }, privateKey: esPriv });

  const cases = [
    [wrong,   { secret: SECRET, nowMs: NOW_MS }],
    [expired, { secret: SECRET, nowMs: NOW_MS }],
    [noSub,   { secret: SECRET, nowMs: NOW_MS }],
    [none,    { secret: SECRET, nowMs: NOW_MS }],
    ['malformed', { secret: SECRET, nowMs: NOW_MS }],
    [esWrong, { secret: SECRET, getKey: () => esPubWrong, nowMs: NOW_MS }],
    [esNoKey, { secret: SECRET, /* no getKey */ nowMs: NOW_MS }],
    [esWrong, { secret: SECRET, getKey: () => null, nowMs: NOW_MS }],
  ];

  // Reference esPub so the linter / dependency graph sees the key was
  // generated; the test deliberately swaps it for esPubWrong above.
  assert.ok(esPub.kid === 'uniform');

  const msgs = new Set();
  for (const [t, opts] of cases) {
    try { await verifySupabaseJwt(t, opts); } catch (e) { msgs.add(e.message); }
  }
  assert.equal(msgs.size, 1, `expected one uniform message; got: ${Array.from(msgs).join(' | ')}`);
});
