'use strict';

/*
 * Test-door HTTP server tests — post-Path-2-auth.
 *
 * The Setup → cookie path is gone. /api/signup and /api/login each
 * route through a stubbed Supabase auth client + a stubbed identity
 * resolver, then seal the same HMAC-signed session cookie the chat
 * endpoint already expects.
 *
 * No real Supabase, no real DB. Pure stubs at the auth + identity
 * boundary so the HTTP surface is testable on a stdlib `node --test`
 * run with no external services.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { createSessionCodec, COOKIE_NAME } = require('../../src/web/session');
const { createRecentBuffer } = require('../../src/web/recent');
const { createTestDoorServer } = require('../../src/web/server');
const { classifyExecutionIntent, INTENT_TYPES } = require('../../src/governance');
const { createResponseDeliveryActor } = require('../../src/actors');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'unit-test-secret-please-rotate';
const JWT_SECRET = 'unit-test-jwt-secret-please-rotate';
const PILOT_UUID  = '11111111-1111-1111-1111-111111111111';
const AUTH_CHRIS  = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const AUTH_JILL   = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
const AUTH_ADMIN  = 'cccccccc-3333-3333-3333-cccccccccccc';

// ---------- Stub helpers ----------

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeValidJwt(sub, iss) {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600, iss }));
  const sig = b64urlEncode(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function captureLog() {
  const lines = [];
  const log = (level, event, fields) => lines.push({ level, event, fields });
  return { log, lines };
}

function buildStubWiring(textOrError, opts) {
  const o = opts || {};
  const auditFields = o.audit || { verdict: 'PASS', details: 'audit-disabled' };
  const memoryFields = o.memory || { stored: 0, extracted: 0 };
  const conversationRuntime = {
    respond: async (input) => {
      assert.equal(input.pilotInstanceId, PILOT_UUID);
      assert.equal(typeof input.userMessage, 'string');
      if (textOrError instanceof Error) throw textOrError;
      return {
        response: textOrError,
        memoryCount: 3,
        auditVerdict: auditFields.verdict,
        auditDetails: auditFields.details,
        auditReason: auditFields.reason,
      };
    },
  };
  const actor = createResponseDeliveryActor({ conversationRuntime });
  return {
    handleChat: async (params) => {
      const decision = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
      const result = await actor.execute(decision, params);
      return {
        outcome: result.outcome,
        decision: result.decision.decision,
        intentType: result.decision.intentType,
        reason: result.decision.reason,
        policyRef: result.decision.policyRef,
        response: result.response,
        memoryCount: result.memoryCount,
        auditVerdict: auditFields.verdict || 'N/A',
        auditDetails: auditFields.details || 'no-audit',
        auditReason: auditFields.reason,
        memoriesStored: memoryFields.stored,
        factsExtracted: memoryFields.extracted,
        executed: result.outcome === 'executed',
      };
    },
    close: async () => {},
  };
}

// Stubbed Supabase auth client. Tests can override `signup` / `login`
// per test via the `overrides` param.
function buildStubSupabaseAuth(overrides) {
  const defaults = {
    signupResults: {},   // email → result object
    loginResults: {},    // email → result object
    expectedIssuer: 'https://test.supabase.co/auth/v1',
  };
  const cfg = Object.assign({}, defaults, overrides || {});
  return {
    signup: async ({ email, password }) => {
      assert.equal(typeof password, 'string');
      const r = cfg.signupResults[email];
      if (!r) return { ok: false, status: 400, code: 'invalid_credentials' };
      return r;
    },
    login: async ({ email, password }) => {
      assert.equal(typeof password, 'string');
      const r = cfg.loginResults[email];
      if (!r) return { ok: false, status: 400, code: 'invalid_credentials' };
      return r;
    },
    _cfg: cfg,
  };
}

// Stubbed identity resolver. Maps authUserId → fake public.users.id +
// role. Records every call so tests can assert "Jill's authUserId
// produced Jill's userId, distinct from Chris's".
function buildStubIdentity() {
  const calls = [];
  const provisioned = new Map();
  let nextId = 0;
  return {
    resolveOrProvision: async ({ authUserId, email }) => {
      calls.push({ authUserId, email });
      let entry = provisioned.get(authUserId);
      if (!entry) {
        nextId += 1;
        const userId = `dddddddd-0000-0000-0000-${String(nextId).padStart(12, '0')}`;
        const role = email && email.startsWith('admin@') ? 'admin' : 'senior';
        entry = { userId, userRole: role, email, displayName: email, isNewUser: true };
        provisioned.set(authUserId, entry);
        return entry;
      }
      return { ...entry, isNewUser: false };
    },
    close: async () => {},
    _calls: calls,
  };
}

function startServer(stubWiringText, opts) {
  const o = opts || {};
  const sessionCodec = createSessionCodec({ secret: SECRET });
  const recent = createRecentBuffer({ capacity: 5 });
  const { log, lines } = captureLog();
  const wiring = buildStubWiring(stubWiringText, o);
  const supabaseAuth = o.supabaseAuth || buildStubSupabaseAuth({});
  const identity = o.identity || buildStubIdentity();
  const server = createTestDoorServer({
    repoRoot: REPO_ROOT,
    pilotInstanceId: PILOT_UUID,
    sessionCodec,
    wiring,
    recent,
    supabaseAuth,
    identity,
    supabaseJwtSecret: JWT_SECRET,
    expectedJwtIssuer: 'https://test.supabase.co/auth/v1',
    log,
    secureCookie: false,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, sessionCodec, recent, lines, supabaseAuth, identity });
    });
  });
}

function req(port, method, pathname, opts) {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = raw.length ? JSON.parse(raw) : null; } catch { body = raw; }
          resolve({ statusCode: res.statusCode, headers: res.headers, body, rawBody: raw });
        });
      }
    );
    r.on('error', reject);
    if (options.body !== undefined) r.write(JSON.stringify(options.body));
    r.end();
  });
}

function cookieFromRes(res) {
  const sc = res.headers['set-cookie'];
  if (!sc || sc.length === 0) return null;
  return sc[0].split(';')[0];
}

// =================================================================
// Static + healthz
// =================================================================

test('GET /healthz returns live', async () => {
  const ctx = await startServer('hi');
  try {
    const r = await req(ctx.port, 'GET', '/healthz');
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { status: 'live' });
  } finally { ctx.server.close(); }
});

test('GET / serves the landing HTML with TEST INSTANCE banner + signup/login forms', async () => {
  const ctx = await startServer('hi');
  try {
    const r = await req(ctx.port, 'GET', '/');
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(r.rawBody, /TEST INSTANCE — SAFE TO BREAK — NOT FACTORY MOLD/);
    assert.match(r.rawBody, /id="login-form"/);
    assert.match(r.rawBody, /id="signup-form"/);
    assert.doesNotMatch(r.rawBody, /id="setup-form"/);
  } finally { ctx.server.close(); }
});

// =================================================================
// /api/signup
// =================================================================

test('signup: missing fields → 400', async () => {
  const ctx = await startServer('hi');
  try {
    const r1 = await req(ctx.port, 'POST', '/api/signup', { body: { email: '', password: '' } });
    assert.equal(r1.statusCode, 400);
    const r2 = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(r2.statusCode, 400, 'displayName required');
  } finally { ctx.server.close(); }
});

test('signup: short password → 400 (no Supabase call)', async () => {
  let signupCalled = false;
  const supabaseAuth = {
    signup: async () => { signupCalled = true; return { ok: false }; },
    login: async () => ({ ok: false }),
  };
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'chris@test.example', password: 'short', displayName: 'Chris' },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(signupCalled, false, 'must not hit Supabase with malformed input');
  } finally { ctx.server.close(); }
});

test('signup success: seals a session cookie and returns isAdmin=false for a senior', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    signupResults: {
      'chris@test.example': {
        ok: true,
        confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        refreshToken: 'r',
        userId: AUTH_CHRIS,
        email: 'chris@test.example',
        emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2', displayName: 'Chris', companionName: 'Mable' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.confirmationPending, false);
    assert.equal(r.body.displayName, 'Chris');
    assert.equal(r.body.userRole, 'senior');
    assert.equal(r.body.companionLabel, 'Mable');
    assert.equal(r.body.isAdmin, false);
    assert.equal(r.body.isNewUser, true);
    const cookie = cookieFromRes(r);
    assert.ok(cookie && cookie.startsWith(COOKIE_NAME + '='));
  } finally { ctx.server.close(); }
});

test('signup with confirmation_pending: no cookie, just a "check your email" body', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    signupResults: {
      'pending@test.example': {
        ok: true,
        confirmationPending: true,
        accessToken: null,
        refreshToken: null,
        userId: AUTH_CHRIS,
        email: 'pending@test.example',
        emailConfirmed: false,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'pending@test.example', password: 'hunter2hunter2', displayName: 'Pending' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.confirmationPending, true);
    assert.equal(cookieFromRes(r), null, 'no cookie until email confirmed');
  } finally { ctx.server.close(); }
});

test('signup with user_exists: uniform 400 error, no enumeration', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    signupResults: { 'taken@test.example': { ok: false, status: 422, code: 'user_exists' } },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'taken@test.example', password: 'hunter2hunter2', displayName: 'X' },
    });
    assert.equal(r.statusCode, 400);
    // Message must NOT say "email already exists" — that's enumeration.
    assert.doesNotMatch(r.body.error, /already|exists|taken/i);
  } finally { ctx.server.close(); }
});

test('signup rate-limited: 429', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    signupResults: { 'rl@test.example': { ok: false, status: 429, code: 'rate_limited' } },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'rl@test.example', password: 'hunter2hunter2', displayName: 'X' },
    });
    assert.equal(r.statusCode, 429);
  } finally { ctx.server.close(); }
});

// =================================================================
// /api/login
// =================================================================

test('login: missing fields → 400', async () => {
  const ctx = await startServer('hi');
  try {
    const r = await req(ctx.port, 'POST', '/api/login', { body: {} });
    assert.equal(r.statusCode, 400);
  } finally { ctx.server.close(); }
});

test('login: wrong password and unknown email both return the SAME 401 (no enumeration)', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'wrong@test.example': { ok: false, status: 400, code: 'invalid_credentials' },
      // unknown@test.example deliberately absent → stub returns invalid_credentials default
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r1 = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'wrong@test.example', password: 'whatever' },
    });
    const r2 = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'unknown@test.example', password: 'whatever' },
    });
    assert.equal(r1.statusCode, 401);
    assert.equal(r2.statusCode, 401);
    assert.equal(r1.body.error, r2.body.error, 'identical error body — no account enumeration');
  } finally { ctx.server.close(); }
});

test('login success: seals cookie + carries the resolved user UUID', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'chris@test.example': {
        ok: true,
        confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        refreshToken: 'r',
        userId: AUTH_CHRIS,
        email: 'chris@test.example',
        emailConfirmed: true,
      },
    },
  });
  const identity = buildStubIdentity();
  const ctx = await startServer('hi', { supabaseAuth, identity });
  try {
    const r = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.userRole, 'senior');
    const cookie = cookieFromRes(r);
    assert.ok(cookie);
    // The identity resolver was hit exactly once with the auth UUID
    assert.equal(identity._calls.length, 1);
    assert.equal(identity._calls[0].authUserId, AUTH_CHRIS);
  } finally { ctx.server.close(); }
});

test('login rejects when JWT was tampered with (sub mismatch with Supabase user.id)', async () => {
  // Supabase says user.id = AUTH_CHRIS but the JWT we received has
  // sub = AUTH_JILL. This must reject — proves we don't blindly trust
  // the unauthenticated user.id field.
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'tampered@test.example': {
        ok: true,
        confirmationPending: false,
        accessToken: makeValidJwt(AUTH_JILL, 'https://test.supabase.co/auth/v1'),
        refreshToken: 'r',
        userId: AUTH_CHRIS, // intentionally different from JWT sub
        email: 'tampered@test.example',
        emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'tampered@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(r.statusCode, 401);
  } finally { ctx.server.close(); }
});

test('login rejects when JWT issuer is wrong', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'wrongiss@test.example': {
        ok: true,
        confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://malicious.example/auth/v1'),
        refreshToken: 'r',
        userId: AUTH_CHRIS,
        email: 'wrongiss@test.example',
        emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'wrongiss@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(r.statusCode, 401);
  } finally { ctx.server.close(); }
});

// =================================================================
// Identity isolation — the load-bearing claim
// =================================================================

test('two distinct logins → two distinct session.userId values', async () => {
  // The Chris/Jill leak proof at the HTTP boundary: distinct auth
  // identities produce distinct cookie payloads. The cookie carries
  // session.userId = identity.userId, and identity is a one-way
  // resolution from authUserId — so distinct authUserId values
  // must produce distinct cookies.
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'chris@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
      },
      'jill@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_JILL, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_JILL, email: 'jill@test.example', emailConfirmed: true,
      },
    },
  });
  const identity = buildStubIdentity();
  const ctx = await startServer('hi', { supabaseAuth, identity });
  try {
    const rc = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    const rj = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'jill@test.example', password: 'hunter2hunter2' },
    });
    const cookieChris = cookieFromRes(rc);
    const cookieJill = cookieFromRes(rj);
    assert.notEqual(cookieChris, cookieJill, 'distinct cookies for distinct logins');

    // Decode the cookies to confirm distinct userIds.
    const codec = ctx.sessionCodec;
    const c = codec.unseal(cookieChris.replace(COOKIE_NAME + '=', ''));
    const j = codec.unseal(cookieJill.replace(COOKIE_NAME + '=', ''));
    assert.ok(c && j);
    assert.notEqual(c.userId, j.userId, 'distinct userId in cookie payloads');
  } finally { ctx.server.close(); }
});

// =================================================================
// /api/chat — unchanged contract verified against new auth
// =================================================================

test('chat without session → 401', async () => {
  const ctx = await startServer('hi');
  try {
    const r = await req(ctx.port, 'POST', '/api/chat', { body: { message: 'hi' } });
    assert.equal(r.statusCode, 401);
  } finally { ctx.server.close(); }
});

test('chat after login: response carries memoryCount, decision, audit fields', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'chris@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hello there', {
    supabaseAuth,
    audit: { verdict: 'PASS', details: 'groq-audit-completed', reason: 'ok' },
    memory: { stored: 2, extracted: 3 },
  });
  try {
    const login = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    const cookie = cookieFromRes(login);
    const r = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'how are you' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.response, 'hello there');
    assert.equal(r.body.outcome, 'executed');
    assert.equal(r.body.auditVerdict, 'PASS');
    assert.equal(r.body.memoriesStored, 2);
    assert.equal(r.body.factsExtracted, 3);
  } finally { ctx.server.close(); }
});

// =================================================================
// Admin gating
// =================================================================

test('admin-recent: admin role required', async () => {
  const supabaseAuth = buildStubSupabaseAuth({
    loginResults: {
      'chris@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
      },
      'admin@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_ADMIN, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_ADMIN, email: 'admin@test.example', emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    const r0 = await req(ctx.port, 'GET', '/api/admin/recent');
    assert.equal(r0.statusCode, 401, 'no session → 401');

    const seniorLogin = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    const r1 = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: cookieFromRes(seniorLogin) },
    });
    assert.equal(r1.statusCode, 403, 'senior role → 403');

    const adminLogin = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'admin@test.example', password: 'hunter2hunter2' },
    });
    const r2 = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: cookieFromRes(adminLogin) },
    });
    assert.equal(r2.statusCode, 200, 'admin role → 200');
  } finally { ctx.server.close(); }
});

// =================================================================
// Privacy invariant — passwords never logged
// =================================================================

test('passwords are never logged', async () => {
  const SENTINEL_PASSWORD = 'SENTINEL-PASSWORD-DO-NOT-LOG-99999';
  const supabaseAuth = buildStubSupabaseAuth({
    signupResults: {
      'chris@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
      },
    },
    loginResults: {
      'chris@test.example': {
        ok: true, confirmationPending: false,
        accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
        userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
      },
    },
  });
  const ctx = await startServer('hi', { supabaseAuth });
  try {
    await req(ctx.port, 'POST', '/api/signup', {
      body: { email: 'chris@test.example', password: SENTINEL_PASSWORD, displayName: 'Chris' },
    });
    await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: SENTINEL_PASSWORD },
    });
    const allLogs = JSON.stringify(ctx.lines);
    assert.ok(!allLogs.includes(SENTINEL_PASSWORD), 'password sentinel must not appear in any log line');
  } finally { ctx.server.close(); }
});

// =================================================================
// Session lifecycle
// =================================================================

test('logout clears the session cookie', async () => {
  const ctx = await startServer('hi');
  try {
    const r = await req(ctx.port, 'POST', '/api/logout', { body: {} });
    assert.equal(r.statusCode, 200);
    const sc = r.headers['set-cookie'];
    assert.ok(sc && sc[0] && /Max-Age=0/.test(sc[0]), 'Set-Cookie must clear the session');
  } finally { ctx.server.close(); }
});

test('session codec round-trips and rejects tampered cookies', () => {
  const codec = createSessionCodec({ secret: SECRET });
  const sealed = codec.seal({
    userId: AUTH_CHRIS, userRole: 'senior', displayName: 'A',
    companionLabel: null, issuedAt: Date.now(),
  });
  assert.ok(codec.unseal(sealed));
  const dot = sealed.indexOf('.');
  const tampered = sealed.slice(0, dot) + sealed.slice(dot + 1, dot + 2).replace(/./, 'X') + sealed.slice(dot + 2);
  assert.equal(codec.unseal(tampered), null);
  const wrong = createSessionCodec({ secret: 'different-secret-of-length' });
  assert.equal(wrong.unseal(sealed), null);
});
