'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createSessionCodec, COOKIE_NAME } = require('../../src/web/session');
const { createRecentBuffer } = require('../../src/web/recent');
const { createTestDoorServer } = require('../../src/web/server');
const { createTestDoorWiring } = require('../../src/web/wiring');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRET = 'unit-test-secret-please-rotate';
const PILOT_UUID  = '11111111-1111-1111-1111-111111111111';
const SENIOR_UUID = '22222222-2222-2222-2222-222222222222';
const ADMIN_UUID  = '33333333-3333-3333-3333-333333333333';

function captureLog() {
  const lines = [];
  const log = (level, event, fields) => lines.push({ level, event, fields });
  return { log, lines };
}

function fakeMemoryPool() {
  // Used by createTestDoorWiring → createCompanionReader.
  // companionReader only checks options.memoryPool is truthy and never
  // dereferences it in these tests because we override the wiring's
  // handleChat via a stub modelClient + stub memoryPool path.
  return Object.freeze({});
}

function fakeMessagesCreate(textOrThrow) {
  return async (req) => {
    if (textOrThrow instanceof Error) throw textOrThrow;
    assert.equal(typeof req.model, 'string');
    assert.ok(Array.isArray(req.messages));
    return { content: [{ type: 'text', text: textOrThrow }] };
  };
}

function fakeModelClient(textOrThrow) {
  return { messages: { create: fakeMessagesCreate(textOrThrow) } };
}

// The companion reader will call withMemoryContext on the memoryPool;
// to keep the unit test hermetic we replace the wiring's handleChat
// with a stub that exercises the public actor/governance path on a
// fake conversation runtime. This isolates the HTTP surface from the
// DB chain (which has its own dedicated integration tests).
const { classifyExecutionIntent, INTENT_TYPES } = require('../../src/governance');
const { createResponseDeliveryActor } = require('../../src/actors');

// buildStubWiring mirrors what src/web/wiring.js produces, including the
// post-9b2d199 fields (auditVerdict, auditDetails, auditReason,
// memoriesStored, factsExtracted). The real wiring is exercised in
// integration tests (tests/integration/); this stub keeps the HTTP
// surface tests hermetic — no real model, no real DB.
function buildStubWiring(textOrError, opts) {
  const o = opts || {};
  const auditFields = o.audit || { verdict: 'PASS', details: 'audit-disabled' };
  const memoryFields = o.memory || { stored: 0, extracted: 0 };
  const conversationRuntime = {
    respond: async (input) => {
      assert.equal(input.pilotInstanceId, PILOT_UUID);
      assert.ok(input.userId === SENIOR_UUID || input.userId === ADMIN_UUID);
      assert.ok(input.userRole === 'senior' || input.userRole === 'admin');
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
      const bundle = {
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
      };
      bundle.executed = bundle.outcome === 'executed';
      return bundle;
    },
    close: async () => {},
  };
}

function startServer(stubWiringText, stubOpts) {
  const sessionCodec = createSessionCodec({ secret: SECRET });
  const recent = createRecentBuffer({ capacity: 5 });
  const { log, lines } = captureLog();
  const wiring = buildStubWiring(stubWiringText, stubOpts);
  const server = createTestDoorServer({
    repoRoot: REPO_ROOT,
    identities: {
      pilotInstanceId: PILOT_UUID,
      seniorUserId: SENIOR_UUID,
      adminUserId: ADMIN_UUID,
    },
    sessionCodec,
    wiring,
    recent,
    log,
    secureCookie: false,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, sessionCodec, recent, lines });
    });
  });
}

function req(port, method, pathname, opts) {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const r = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = raw.length ? JSON.parse(raw) : null; } catch { body = raw; }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            rawBody: raw,
          });
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
  const first = sc[0].split(';')[0];
  return first;
}

test('GET /healthz returns live', async () => {
  const ctx = await startServer('hello');
  try {
    const res = await req(ctx.port, 'GET', '/healthz');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'live' });
  } finally {
    ctx.server.close();
  }
});

test('GET / serves the landing HTML with TEST INSTANCE banner', async () => {
  const ctx = await startServer('hello');
  try {
    const res = await req(ctx.port, 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.rawBody, /TEST INSTANCE — SAFE TO BREAK — NOT FACTORY MOLD/);
    assert.match(res.rawBody, /id="setup-form"/);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/setup with regular role seals a senior session', async () => {
  const ctx = await startServer('hello');
  try {
    const res = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'Margaret', role: 'regular', companionName: 'Mable' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.displayName, 'Margaret');
    assert.equal(res.body.userRole, 'senior');
    assert.equal(res.body.companionLabel, 'Mable');
    assert.equal(res.body.isAdmin, false);
    const cookie = cookieFromRes(res);
    assert.ok(cookie && cookie.startsWith(COOKIE_NAME + '='));
  } finally {
    ctx.server.close();
  }
});

test('POST /api/setup with admin role seals an admin session', async () => {
  const ctx = await startServer('hello');
  try {
    const res = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'Riley', role: 'admin' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.userRole, 'admin');
    assert.equal(res.body.isAdmin, true);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/setup rejects unknown role and missing name', async () => {
  const ctx = await startServer('hello');
  try {
    const r1 = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'x', role: 'wizard' },
    });
    assert.equal(r1.statusCode, 400);
    const r2 = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: '   ', role: 'regular' },
    });
    assert.equal(r2.statusCode, 400);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/chat without session returns 401', async () => {
  const ctx = await startServer('hello');
  try {
    const res = await req(ctx.port, 'POST', '/api/chat', { body: { message: 'hi' } });
    assert.equal(res.statusCode, 401);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/chat with sealed session returns response + governance fields', async () => {
  const ctx = await startServer('hello there');
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'Margaret', role: 'regular' },
    });
    const cookie = cookieFromRes(setup);
    const res = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'How are you?' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.response, 'hello there');
    assert.equal(res.body.memoryCount, 3);
    assert.equal(res.body.outcome, 'executed');
    assert.equal(res.body.decision, 'admissible');
    assert.equal(res.body.intentType, 'response.deliver');
    assert.equal(typeof res.body.reason, 'string');
    assert.equal(typeof res.body.policyRef, 'string');
    assert.equal(res.body.executed, true);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/chat with empty message returns 400', async () => {
  const ctx = await startServer('hi');
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'regular' },
    });
    const cookie = cookieFromRes(setup);
    const res = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: '   ' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/chat surfaces a model error as 502 and records error in buffer', async () => {
  const err = new Error('boom');
  err.status = 500;
  const ctx = await startServer(err);
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'admin' },
    });
    const cookie = cookieFromRes(setup);
    const res = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'hello' },
    });
    assert.equal(res.statusCode, 502);
    assert.equal(typeof res.body.errorClass, 'string');

    const recentRes = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: cookie },
    });
    assert.equal(recentRes.statusCode, 200);
    assert.equal(recentRes.body.size, 1);
    assert.equal(recentRes.body.entries[0].outcome, 'error');
    assert.ok(recentRes.body.entries[0].errorClass);
  } finally {
    ctx.server.close();
  }
});

test('GET /api/admin/recent is admin-only', async () => {
  const ctx = await startServer('hi');
  try {
    const noSession = await req(ctx.port, 'GET', '/api/admin/recent');
    assert.equal(noSession.statusCode, 401);

    const regSetup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'regular' },
    });
    const regCookie = cookieFromRes(regSetup);
    const regRes = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: regCookie },
    });
    assert.equal(regRes.statusCode, 403);

    const adminSetup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'admin' },
    });
    const adminCookie = cookieFromRes(adminSetup);
    const adminRes = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(adminRes.statusCode, 200);
    assert.equal(typeof adminRes.body.capacity, 'number');
    assert.ok(Array.isArray(adminRes.body.entries));
  } finally {
    ctx.server.close();
  }
});

test('ring buffer records metadata only — no user message, no response text', async () => {
  const ctx = await startServer('SENTINEL_RESPONSE');
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'admin' },
    });
    const cookie = cookieFromRes(setup);
    await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'SENTINEL_USER_MESSAGE' },
    });
    const recentRes = await req(ctx.port, 'GET', '/api/admin/recent', {
      headers: { Cookie: cookie },
    });
    const dump = JSON.stringify(recentRes.body);
    assert.ok(!dump.includes('SENTINEL_USER_MESSAGE'), 'user message must not appear in recent ring');
    assert.ok(!dump.includes('SENTINEL_RESPONSE'), 'response text must not appear in recent ring');
    assert.equal(recentRes.body.entries[0].responseChars, 'SENTINEL_RESPONSE'.length);
  } finally {
    ctx.server.close();
  }
});

test('log lines never contain user message or response text', async () => {
  const ctx = await startServer('SENTINEL_RESPONSE');
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'regular' },
    });
    const cookie = cookieFromRes(setup);
    await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'SENTINEL_USER_MESSAGE' },
    });
    const blob = JSON.stringify(ctx.lines);
    assert.ok(!blob.includes('SENTINEL_USER_MESSAGE'), 'user message must not appear in logs');
    assert.ok(!blob.includes('SENTINEL_RESPONSE'), 'response text must not appear in logs');
  } finally {
    ctx.server.close();
  }
});

test('session codec round-trips and rejects tampered cookies', async () => {
  const codec = createSessionCodec({ secret: SECRET });
  const sealed = codec.seal({
    userId: SENIOR_UUID,
    userRole: 'senior',
    displayName: 'A',
    companionLabel: null,
    issuedAt: Date.now(),
  });
  const ok = codec.unseal(sealed);
  assert.ok(ok);
  assert.equal(ok.userRole, 'senior');

  const dot = sealed.indexOf('.');
  const tampered = sealed.slice(0, dot) + sealed.slice(dot + 1, dot + 2).replace(/./, 'X') + sealed.slice(dot + 2);
  assert.equal(codec.unseal(tampered), null);

  const wrongSecret = createSessionCodec({ secret: 'different-secret-of-length' });
  assert.equal(wrongSecret.unseal(sealed), null);
});

test('POST /api/chat passes brain-runtime audit fields through to the HTTP response', async () => {
  const ctx = await startServer('hello there', {
    audit: { verdict: 'PASS', details: 'groq-audit-completed', reason: 'consistent with memories' },
    memory: { stored: 2, extracted: 3 },
  });
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'Margaret', role: 'regular' },
    });
    const cookie = cookieFromRes(setup);
    const res = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'How are you?' },
    });
    assert.equal(res.statusCode, 200);
    // wiring.js bundles these fields after the actor returns; the
    // server's handleChat passes the whole bundle as JSON.
    assert.equal(res.body.auditVerdict || 'N/A', 'PASS');
    assert.equal(res.body.auditDetails || 'no-audit', 'groq-audit-completed');
    assert.equal(res.body.auditReason, 'consistent with memories');
    assert.equal(res.body.memoriesStored, 2);
    assert.equal(res.body.factsExtracted, 3);
  } finally {
    ctx.server.close();
  }
});

test('POST /api/chat passes audit FAIL verdict + reason through', async () => {
  const ctx = await startServer('the response that the auditor disliked', {
    audit: { verdict: 'FAIL', details: 'groq-audit-completed', reason: 'response asserts a fact not in memories' },
    memory: { stored: 0, extracted: 0 },
  });
  try {
    const setup = await req(ctx.port, 'POST', '/api/setup', {
      body: { name: 'A', role: 'regular' },
    });
    const cookie = cookieFromRes(setup);
    const res = await req(ctx.port, 'POST', '/api/chat', {
      headers: { Cookie: cookie },
      body: { message: 'what do you remember about me?' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.auditVerdict, 'FAIL');
    assert.match(res.body.auditReason, /not in memories/);
  } finally {
    ctx.server.close();
  }
});

test('createTestDoorWiring rejects missing ANTHROPIC_API_KEY when no modelClient override', () => {
  assert.throws(
    () => createTestDoorWiring({
      env: {},
      log: () => {},
      memoryPool: fakeMemoryPool(),
    }),
    /ANTHROPIC_API_KEY is required/
  );
});

test('createTestDoorWiring rejects missing LYLO_APP_DATABASE_URL when no memoryPool override', () => {
  assert.throws(
    () => createTestDoorWiring({
      env: { ANTHROPIC_API_KEY: 'x' },
      log: () => {},
      modelClient: fakeModelClient('x'),
    }),
    /LYLO_APP_DATABASE_URL is required/
  );
});
