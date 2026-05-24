'use strict';
/*
 * Companion-read integration test (GM-19).
 *
 * Proves the read-only companion consumer engages the same RLS
 * policies the GM-17 memory-governance suite proves at the library
 * level — but via the production-shaped code path:
 *   createMemoryPool → createCompanionReader → reader.readVisibleMemories.
 *
 * Per OQ-19.9, this test reuses tests/rls-contract/fixtures.sql so
 * the identifiers align across suites.
 *
 * Schema reset stays on the bootstrap superuser (OQ-16.6). The
 * companion reader connects via LYLO_APP_DATABASE_URL through the
 * memory module's createMemoryPool.
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

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

// Identifiers from tests/rls-contract/fixtures.sql.
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

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(
    LYLO_APP_DATABASE_URL,
    'LYLO_APP_DATABASE_URL (lylo_app LOGIN role) must be set'
  );

  // Reset schema + apply migrations + seed two-pilot fixture as the
  // bootstrap superuser.
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

  // Build the production-shape pool + reader.
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

// ---- visibility-matrix parity with GM-17 memory-governance.test.js ----

test('companion-read: senior reads own memories across all visibility levels (parity with GM-17 scenario 1)', async () => {
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    limit: 100,
  });
  const ids = rows.map((r) => r.id);
  for (const expected of [
    MEM_A_PRIVATE,
    MEM_A_FAMILY_SHARED,
    MEM_A_PASSWORD_LOCKED,
    MEM_A_INADMISSIBLE,
  ]) {
    assert.ok(ids.includes(expected), `senior must see own memory ${expected}`);
  }
});

test('companion-read: family with family_shared permission sees only the admissible family_shared row', async () => {
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: FAMILY_A,
    userRole: 'family',
    limit: 100,
  });
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
  assert.equal(ids.includes(MEM_A_PRIVATE), false);
  assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
  assert.equal(ids.includes(MEM_A_INADMISSIBLE), false);
});

test('companion-read: caregiver-A (no family_shared permission) sees nothing', async () => {
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: CAREGIVER_A,
    userRole: 'caregiver',
    limit: 100,
  });
  assert.deepEqual(rows, []);
});

test('companion-read: admin-A sees no memory_store rows (OQ-14.2)', async () => {
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: ADMIN_A,
    userRole: 'admin',
    limit: 100,
  });
  assert.deepEqual(rows, []);
});

test('companion-read: cross-pilot — pilot-B senior sees only pilot-B memories, never any pilot-A row', async () => {
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_B,
    userId: SENIOR_B,
    userRole: 'senior',
    limit: 100,
  });
  const ids = rows.map((r) => r.id);
  for (const pilotARow of [
    MEM_A_PRIVATE,
    MEM_A_FAMILY_SHARED,
    MEM_A_PASSWORD_LOCKED,
    MEM_A_INADMISSIBLE,
  ]) {
    assert.equal(ids.includes(pilotARow), false, `pilot-B senior must NOT see ${pilotARow}`);
  }
});

// ---- invariants the read-only consumer must preserve ----

test('companion-read: memory_store row count is unchanged before/after a read (no writes leak through the consumer)', async () => {
  const before = await memoryCount(PILOT_A);
  await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    limit: 100,
  });
  const after = await memoryCount(PILOT_A);
  assert.equal(after, before, 'no INSERT may have occurred during a read');
});

test('companion-read: governance_audit_log grows by exactly one memory.list row per readVisibleMemories call', async () => {
  const beforeCount = await listAuditCount(PILOT_A);
  await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    limit: 100,
  });
  await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    limit: 100,
  });
  const afterCount = await listAuditCount(PILOT_A);
  assert.equal(
    afterCount - beforeCount,
    2,
    'each readVisibleMemories must emit exactly one memory.list audit row'
  );
});

test('companion-read: pg errors emerge as MemoryRepositoryError (no pg detail leak through the consumer)', async () => {
  // Force an FK violation by passing a syntactically-valid UUID for
  // userId that does not correspond to any users row in the pilot.
  // The audit INSERT's composite FK (pilot_instance_id, actor_user_id)
  // → users (pilot_instance_id, id) raises SQLSTATE 23503.
  const orphan = '00000000-0000-0000-0000-deadbeefdead';
  const { MemoryRepositoryError } = require('../../src/companion');
  let caught;
  try {
    await reader.readVisibleMemories({
      pilotInstanceId: PILOT_A,
      userId: orphan,
      userRole: 'senior',
      limit: 100,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'must have caught the wrapped error');
  assert.ok(caught instanceof MemoryRepositoryError);
  assert.equal(caught.name, 'MemoryRepositoryError');
  assert.equal(caught.message, 'memory operation failed');
  assert.ok(/^[0-9A-Z]{5}$/.test(caught.error_class), `error_class must be SQLSTATE: ${caught.error_class}`);
  // pg internals must not have leaked.
  assert.equal(caught.detail, undefined);
  assert.equal(caught.where, undefined);
  assert.equal(caught.routine, undefined);
  assert.equal(caught.message.includes(orphan), false);
});
