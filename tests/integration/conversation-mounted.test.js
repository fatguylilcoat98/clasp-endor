'use strict';
/*
 * Conversation-mounted integration test (GM-20).
 *
 * The first integration test that exercises the full chain:
 *   createConversationRuntime
 *     → companionReader.readVisibleMemories
 *       → withMemoryContext + ctx.listVisibleMemories
 *         → lylo_app LOGIN role + RLS
 *
 * The model SDK is mocked (see makeMockSdkClient). The integration
 * point is the chain from the conversation runtime DOWN to Postgres
 * — not the chain from the conversation runtime UP to a real model
 * vendor. A future GM that mounts the conversation runtime in a
 * process is the right place to exercise the real SDK.
 *
 * Reuses tests/rls-contract/fixtures.sql for the two-pilot seed.
 * Schema reset stays on the bootstrap superuser (OQ-16.6).
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createMemoryPool, closeMemoryPool } = require('../../src/memory');
const { createCompanionReader } = require('../../src/companion');
const { createConversationRuntime } = require('../../src/conversation');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const FAMILY_A = 'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa';
const CAREGIVER_A = 'aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const SENIOR_B = 'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb';

const MEM_A_PRIVATE = 'aaaaaaaa-cccc-1111-1111-100000000001';
const MEM_A_FAMILY_SHARED = 'aaaaaaaa-cccc-1111-1111-100000000002';
const MEM_A_PASSWORD_LOCKED = 'aaaaaaaa-cccc-1111-1111-100000000003';
const MEM_A_INADMISSIBLE = 'aaaaaaaa-cccc-1111-1111-100000000004';

let appPool;
let reader;

function makeMockSdkClient(responseText) {
  const requests = [];
  let calls = 0;
  return {
    getCalls: () => calls,
    getRequests: () => requests,
    messages: {
      create: async (req) => {
        calls += 1;
        requests.push(req);
        return {
          content: [{ type: 'text', text: responseText || 'OK' }],
        };
      },
    },
  };
}

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL (lylo_app LOGIN role) must be set');

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  appPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
  reader = createCompanionReader({ memoryPool: appPool });
});

after(async () => {
  if (appPool) await closeMemoryPool(appPool);
});

async function asSuperuserScalar(sql, params) {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(sql, params || []);
    return r.rows[0];
  } finally {
    await su.end();
  }
}

async function memoryCount(pilotInstanceId) {
  const row = await asSuperuserScalar(
    'SELECT COUNT(*)::int AS n FROM memory_store WHERE pilot_instance_id = $1',
    [pilotInstanceId]
  );
  return row.n;
}

async function listAuditCount(pilotInstanceId) {
  const row = await asSuperuserScalar(
    "SELECT COUNT(*)::int AS n FROM governance_audit_log WHERE pilot_instance_id = $1 AND event_type = 'memory.list'",
    [pilotInstanceId]
  );
  return row.n;
}

function makeRuntime(modelClient) {
  return createConversationRuntime({
    companionReader: reader,
    modelClient,
  });
}

// ---- visibility-rule parity through the mounted runtime ----

test('conversation-mounted: senior sees own memory rows in the SDK request system prompt', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    userMessage: 'hello',
  });
  assert.equal(sdk.getCalls(), 1, 'exactly one model call');
  const [req] = sdk.getRequests();
  for (const id of [MEM_A_PRIVATE, MEM_A_FAMILY_SHARED, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE]) {
    assert.ok(req.system.includes(id), `prompt must include senior's own memory ${id}`);
  }
});

test('conversation-mounted: family with permission sees only the admissible family_shared row', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: FAMILY_A,
    userRole: 'family',
    userMessage: 'hello',
  });
  const [req] = sdk.getRequests();
  assert.ok(req.system.includes(MEM_A_FAMILY_SHARED), 'family must see the admissible family_shared row');
  for (const id of [MEM_A_PRIVATE, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE]) {
    assert.equal(req.system.includes(id), false, `family must NOT see ${id}`);
  }
});

test('conversation-mounted: caregiver without permission sees nothing in the prompt', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: CAREGIVER_A,
    userRole: 'caregiver',
    userMessage: 'hello',
  });
  const [req] = sdk.getRequests();
  assert.ok(req.system.includes('No memory context available.'));
  for (const id of [MEM_A_PRIVATE, MEM_A_FAMILY_SHARED, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE]) {
    assert.equal(req.system.includes(id), false, `caregiver must NOT see ${id}`);
  }
});

test('conversation-mounted: admin sees no memory_store rows in the prompt (OQ-14.2)', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: ADMIN_A,
    userRole: 'admin',
    userMessage: 'hello',
  });
  const [req] = sdk.getRequests();
  assert.ok(req.system.includes('No memory context available.'));
});

test('conversation-mounted: cross-pilot isolation — pilot-B senior never sees any pilot-A row', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_B,
    userId: SENIOR_B,
    userRole: 'senior',
    userMessage: 'hello',
  });
  const [req] = sdk.getRequests();
  for (const pilotARow of [MEM_A_PRIVATE, MEM_A_FAMILY_SHARED, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE]) {
    assert.equal(req.system.includes(pilotARow), false, `pilot-B senior must NOT see ${pilotARow}`);
  }
});

// ---- no-write invariants through the mounted runtime ----

test('conversation-mounted: memory_store row count is unchanged across two respond() calls', async () => {
  const before = await memoryCount(PILOT_A);
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  for (let i = 0; i < 2; i += 1) {
    await rt.respond({
      pilotInstanceId: PILOT_A,
      userId: SENIOR_A,
      userRole: 'senior',
      userMessage: 'still hello',
    });
  }
  const after = await memoryCount(PILOT_A);
  assert.equal(after, before, 'no INSERT may have occurred');
});

test('conversation-mounted: governance_audit_log grows by exactly ONE memory.list row per respond()', async () => {
  const beforeCount = await listAuditCount(PILOT_A);
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    userMessage: 'hi',
  });
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    userMessage: 'hi again',
  });
  const afterCount = await listAuditCount(PILOT_A);
  assert.equal(afterCount - beforeCount, 2);
});

// ---- SDK request shape ----

test('conversation-mounted: SDK request NEVER contains streaming/tool-calling fields', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    userMessage: 'hi',
  });
  const [req] = sdk.getRequests();
  for (const forbidden of ['tools', 'tool_choice', 'tool_use', 'tool_result', 'stream']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(req, forbidden),
      false,
      `SDK request must not contain "${forbidden}"`
    );
  }
});

test('conversation-mounted: exactly ONE SDK call per respond()', async () => {
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  await rt.respond({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    userMessage: 'hi',
  });
  assert.equal(sdk.getCalls(), 1);
});

// ---- MemoryRepositoryError propagation through the mounted runtime ----

test('conversation-mounted: MemoryRepositoryError propagates sanitized (no pg detail leak)', async () => {
  // Force an FK violation in the audit-log INSERT by supplying a
  // syntactically-valid UUID for userId that does not match any users
  // row. The audit INSERT raises 23503; the memory module wraps it
  // into MemoryRepositoryError; the conversation runtime lets it
  // propagate; the SDK is never called.
  const sdk = makeMockSdkClient('OK');
  const rt = makeRuntime(sdk);
  const orphan = '00000000-0000-0000-0000-deadbeefdead';
  const { MemoryRepositoryError } = require('../../src/memory');
  let caught;
  try {
    await rt.respond({
      pilotInstanceId: PILOT_A,
      userId: orphan,
      userRole: 'senior',
      userMessage: 'hi',
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.ok(caught instanceof MemoryRepositoryError, 'must be MemoryRepositoryError');
  assert.equal(caught.message, 'memory operation failed');
  assert.equal(caught.detail, undefined);
  assert.equal(caught.where, undefined);
  assert.equal(caught.routine, undefined);
  assert.equal(caught.message.includes(orphan), false);
  assert.equal(sdk.getCalls(), 0, 'SDK must NOT be called when memory access fails');
});
