'use strict';

/*
 * Identity-debug logging tests — proves the LYLO_DEBUG_IDENTITY=true
 * gate emits the expected diagnostic events at the right layers
 * and that the gate, when off, emits nothing identity-related.
 *
 * These tests do NOT make real Anthropic / OpenAI / Postgres calls.
 * The conversation runtime is exercised via the web/server test
 * harness with a stubbed wiring — exactly the same fixture the rest
 * of the web tests use. We're proving the gating behavior of the
 * server-layer trace events, not the brain pipeline.
 *
 * The brain-layer events are integration-tested implicitly by
 * tests/conversation/* once a real model client is in play. Here we
 * focus on the gate + the trace_id linkage at the web boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { createSessionCodec, COOKIE_NAME } = require('../../src/web/session');
const { createRecentBuffer } = require('../../src/web/recent');
const { createTestDoorServer } = require('../../src/web/server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'unit-test-secret-please-rotate';
const JWT_SECRET = 'unit-test-jwt-secret-please-rotate';
const PILOT_UUID = '11111111-1111-1111-1111-111111111111';
const AUTH_CHRIS = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

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

function buildStubSupabaseAuth(loginResults) {
  return {
    signup: async () => ({ ok: false, status: 400, code: 'invalid_credentials' }),
    login: async ({ email, password }) => {
      const r = loginResults[email];
      if (!r) return { ok: false, status: 400, code: 'invalid_credentials' };
      assert.equal(typeof password, 'string');
      return r;
    },
  };
}

function buildStubIdentity() {
  const provisioned = new Map();
  let nextId = 0;
  return {
    resolveOrProvision: async ({ authUserId, email }) => {
      let entry = provisioned.get(authUserId);
      if (!entry) {
        nextId += 1;
        const userId = `dddddddd-0000-0000-0000-${String(nextId).padStart(12, '0')}`;
        entry = { userId, userRole: 'senior', email, displayName: email, isNewUser: true };
        provisioned.set(authUserId, entry);
        return entry;
      }
      return { ...entry, isNewUser: false };
    },
    close: async () => {},
  };
}

function buildStubWiring() {
  const handleChatCalls = [];
  return {
    handleChat: async (params) => {
      handleChatCalls.push(params);
      return {
        outcome: 'executed', decision: 'execute', intentType: 'response.deliver',
        reason: null, policyRef: null, response: 'ok', memoryCount: 0,
        auditVerdict: 'N/A', auditDetails: 'no-audit', auditReason: null,
        memoriesStored: 0, factsExtracted: 0, visibilityLevel: 'private',
        executed: true,
      };
    },
    listMemoriesForInspector: async () => [],
    listGovernanceEvents: async () => [],
    listCircleContacts: async () => [],
    addCircleContact: async () => ({ id: 'x', contactUserId: 'y', visibilityLevels: [], createdAt: '' }),
    setCircleContactPermissions: async (p) => ({ id: p.id, visibilityLevels: p.visibilityLevels }),
    close: async () => {},
    _handleChatCalls: handleChatCalls,
  };
}

function startServer(env) {
  // Mutate env BEFORE require — the gate is read at module load.
  const oldVal = process.env.LYLO_DEBUG_IDENTITY;
  if (env.LYLO_DEBUG_IDENTITY !== undefined) {
    process.env.LYLO_DEBUG_IDENTITY = env.LYLO_DEBUG_IDENTITY;
  } else {
    delete process.env.LYLO_DEBUG_IDENTITY;
  }
  // Re-require the server module so the gate is re-evaluated for
  // this test. We delete from cache to force a fresh load.
  delete require.cache[require.resolve('../../src/web/server')];
  const { createTestDoorServer: freshFactory } = require('../../src/web/server');

  const sessionCodec = createSessionCodec({ secret: SECRET });
  const recent = createRecentBuffer({ capacity: 5 });
  const lines = [];
  const log = (level, event, fields) => lines.push({ level, event, fields });
  const wiring = buildStubWiring();
  const supabaseAuth = buildStubSupabaseAuth({
    'chris@test.example': {
      ok: true, confirmationPending: false,
      accessToken: makeValidJwt(AUTH_CHRIS, 'https://test.supabase.co/auth/v1'),
      userId: AUTH_CHRIS, email: 'chris@test.example', emailConfirmed: true,
    },
  });
  const identity = buildStubIdentity();
  const server = freshFactory({
    repoRoot: REPO_ROOT,
    pilotInstanceId: PILOT_UUID,
    sessionCodec,
    wiring,
    recent,
    supabaseAuth,
    identity,
    supabaseJwtSecret: JWT_SECRET,
    jwtKeyLookup: async () => null,
    expectedJwtIssuer: 'https://test.supabase.co/auth/v1',
    log,
    secureCookie: false,
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server, port, lines, wiring, sessionCodec,
        restore: () => {
          if (oldVal === undefined) delete process.env.LYLO_DEBUG_IDENTITY;
          else process.env.LYLO_DEBUG_IDENTITY = oldVal;
          delete require.cache[require.resolve('../../src/web/server')];
        },
      });
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
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
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

test('LYLO_DEBUG_IDENTITY=off: no identity_debug.* events emitted on login or chat', async () => {
  const ctx = await startServer({});
  try {
    const login = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(login.statusCode, 200);
    await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookieFromRes(login) },
      body: { message: 'hi' },
    });
    const debugEvents = ctx.lines.filter((l) => l.event.startsWith('identity_debug.'));
    assert.equal(debugEvents.length, 0,
      `expected zero identity_debug events when gate is off; got ${debugEvents.length}`);
  } finally {
    ctx.server.close();
    ctx.restore();
  }
});

test('LYLO_DEBUG_IDENTITY=true: emits auth.resolved + chat.session_view + chat.companion_config with trace_id', async () => {
  const ctx = await startServer({ LYLO_DEBUG_IDENTITY: 'true' });
  try {
    const login = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    assert.equal(login.statusCode, 200);
    const chat = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookieFromRes(login) },
      body: { message: 'hi' },
    });
    assert.equal(chat.statusCode, 200);

    const events = ctx.lines.filter((l) => l.event.startsWith('identity_debug.'));
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('identity_debug.auth.resolved'),
      `missing identity_debug.auth.resolved in ${JSON.stringify(eventNames)}`);
    assert.ok(eventNames.includes('identity_debug.chat.session_view'),
      `missing identity_debug.chat.session_view in ${JSON.stringify(eventNames)}`);
    assert.ok(eventNames.includes('identity_debug.chat.companion_config'),
      `missing identity_debug.chat.companion_config in ${JSON.stringify(eventNames)}`);

    // chat.session_view and chat.companion_config share trace_id.
    const sessionView = events.find((e) => e.event === 'identity_debug.chat.session_view');
    const companionConfig = events.find((e) => e.event === 'identity_debug.chat.companion_config');
    assert.equal(typeof sessionView.fields.trace_id, 'string');
    assert.equal(sessionView.fields.trace_id, companionConfig.fields.trace_id,
      'trace_id must link the two chat events from a single request');

    // The companion config event carries the COMPANION NAME — this is
    // the field that matters for the "Your name is Jill" leak. The
    // signup did not provide companionName, so the default 'Assistant'
    // must be what reaches the brain.
    assert.equal(companionConfig.fields.companion_name, 'Assistant');

    // The session view records the cookie's companion_label value
    // verbatim. For this signup it was null (not provided).
    assert.equal(sessionView.fields.session_companion_label_value, null);
  } finally {
    ctx.server.close();
    ctx.restore();
  }
});

test('LYLO_DEBUG_IDENTITY=true: wiring receives the trace_id so brain-layer events can be linked', async () => {
  const ctx = await startServer({ LYLO_DEBUG_IDENTITY: 'true' });
  try {
    const login = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookieFromRes(login) },
      body: { message: 'hi' },
    });
    assert.equal(ctx.wiring._handleChatCalls.length, 1);
    const params = ctx.wiring._handleChatCalls[0];
    assert.equal(typeof params.traceId, 'string');
    assert.ok(params.traceId.length > 4, 'traceId must be present and non-trivial');

    // Trace_id from the wiring call matches the chat.session_view event.
    const sessionView = ctx.lines.find((l) => l.event === 'identity_debug.chat.session_view');
    assert.equal(params.traceId, sessionView.fields.trace_id);
  } finally {
    ctx.server.close();
    ctx.restore();
  }
});

test('LYLO_DEBUG_IDENTITY events never leak the user message text or response text', async () => {
  const SENTINEL = 'sentinel-user-text-must-not-leak-78293';
  const ctx = await startServer({ LYLO_DEBUG_IDENTITY: 'true' });
  try {
    const login = await req(ctx.port, 'POST', '/api/login', {
      body: { email: 'chris@test.example', password: 'hunter2hunter2' },
    });
    await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookieFromRes(login) },
      body: { message: SENTINEL },
    });
    const allDebug = JSON.stringify(
      ctx.lines.filter((l) => l.event.startsWith('identity_debug.'))
    );
    assert.ok(!allDebug.includes(SENTINEL),
      'identity_debug events must not include the user message text');
  } finally {
    ctx.server.close();
    ctx.restore();
  }
});
