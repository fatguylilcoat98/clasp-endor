'use strict';

/*
 * Memory-governance integration test.
 *
 * Proves the GM-17 memory module — connecting as the lylo_app LOGIN
 * role, bound to per-request app.* session vars by withMemoryContext —
 * obeys the RLS policies on the real schema. Complements the
 * rls-contract suites (which operate at the policy level under SET
 * LOCAL ROLE) by exercising the production code path: the LOGIN
 * role + connection string + the public memory API + the audit
 * bundling.
 *
 * Four URLs are consumed (extends GM-16's OQ-16.6):
 *   DATABASE_URL                — bootstrap superuser; schema reset
 *                                 and fixture seeding.
 *   LYLO_RUNTIME_DATABASE_URL   — lylo_runtime LOGIN role; not used
 *                                 here directly, but the test depends
 *                                 on the same fixtures the boot suite
 *                                 uses.
 *   LYLO_SETUP_DATABASE_URL     — lylo_setup LOGIN role; not used
 *                                 directly.
 *   LYLO_APP_DATABASE_URL       — lylo_app LOGIN role (NO BYPASSRLS);
 *                                 what the memory module connects
 *                                 with.
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const {
  createMemoryPool,
  closeMemoryPool,
  withMemoryContext,
} = require('../../src/memory');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

// Identifiers reused from tests/rls-contract/fixtures.sql — keeping the
// same IDs lets a reader cross-reference the synthetic-schema matrix
// (run-contract.js) with the real-schema runtime path (here).
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

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(
    LYLO_APP_DATABASE_URL,
    'LYLO_APP_DATABASE_URL (lylo_app LOGIN role) must be set'
  );

  // Reset schema and apply migrations as the bootstrap superuser
  // (OQ-16.6: privileged steps stay on the superuser).
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
  // Seed the two-pilot fixture (reuses the rls-contract fixture file).
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  appPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (appPool) await closeMemoryPool(appPool);
});

async function countRowsAsSuperuser(table, where, params) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${table}${where ? ' WHERE ' + where : ''}`,
      params || []
    );
    return r.rows[0].n;
  } finally {
    await client.end();
  }
}

// Scenario 1.
test('memory-governance: senior reads own memories across all visibility levels (password_locked included because the fixture seeds an open session)', async () => {
  const rows = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    (ctx) => ctx.listVisibleMemories({ limit: 100 })
  );
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

// Scenario 2.
test('memory-governance: family-A with family_shared permission sees only the admissible family_shared row', async () => {
  const rows = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: FAMILY_A, userRole: 'family' },
    (ctx) => ctx.listVisibleMemories({ limit: 100 })
  );
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
  assert.equal(ids.includes(MEM_A_PRIVATE), false, 'family must NOT see private');
  assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'family must NOT see password_locked');
  assert.equal(ids.includes(MEM_A_INADMISSIBLE), false, 'family must NOT see inadmissible');
});

// Scenario 3.
test('memory-governance: caregiver-A (no family_shared permission) sees nothing', async () => {
  const rows = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: CAREGIVER_A, userRole: 'caregiver' },
    (ctx) => ctx.listVisibleMemories({ limit: 100 })
  );
  assert.deepEqual(rows, []);
});

// Scenario 4.
test('memory-governance: admin-A sees no memory_store rows (OQ-14.2)', async () => {
  const rows = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    (ctx) => ctx.listVisibleMemories({ limit: 100 })
  );
  assert.deepEqual(rows, []);
});

// Scenario 5.
test('memory-governance: cross-pilot — pilot-B senior never sees any of pilot-A\'s memories', async () => {
  // Note: pairing a pilot-A user with app.pilot_instance_id=B is
  // structurally forbidden by the audit-log FK
  // (pilot_instance_id, actor_user_id) → users — an audit INSERT
  // through the bundled API would violate that FK. The real test of
  // cross-pilot isolation is: a legitimate pilot-B user sees only
  // pilot-B rows, never any pilot-A row.
  const rows = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_B, userId: SENIOR_B, userRole: 'senior' },
    (ctx) => ctx.listVisibleMemories({ limit: 100 })
  );
  // Pilot B's fixture seeds exactly one memory (MEM_B_PRIVATE).
  const ids = rows.map((r) => r.id);
  assert.equal(ids.includes(MEM_A_PRIVATE), false, 'pilot-B senior must NOT see MEM_A_PRIVATE');
  assert.equal(ids.includes(MEM_A_FAMILY_SHARED), false, 'pilot-B senior must NOT see MEM_A_FAMILY_SHARED');
  assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'pilot-B senior must NOT see MEM_A_PASSWORD_LOCKED');
  assert.equal(ids.includes(MEM_A_INADMISSIBLE), false, 'pilot-B senior must NOT see MEM_A_INADMISSIBLE');
  // And every visible row belongs to pilot B.
  // (We don't query pilot_instance_id from memory_store because
  // listVisibleMemories doesn't return it; instead we rely on RLS
  // tenant-scope having filtered already, which the four assertions
  // above prove.)
});

// Scenario 6.
test('memory-governance: default-deny — a connection that bypasses withMemoryContext and runs a raw SELECT without session vars sees zero rows', async () => {
  // This test bypasses the memory module on purpose: a raw client
  // connects with the lylo_app URL and runs a SELECT without any
  // set_config call. The NULLIF guards in the GM-15 policies turn the
  // tenant-scope comparison into NULL, so every row is filtered.
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    const r = await raw.query('SELECT id FROM memory_store');
    assert.deepEqual(r.rows, [], 'default-deny must return zero rows when session vars are unset');
  } finally {
    await raw.end();
  }
});

// Scenario 7.
test('memory-governance: insertPrivateMemory commits the memory row AND a paired memory.created audit row in the same transaction', async () => {
  const beforeMemCount = await countRowsAsSuperuser(
    'memory_store',
    'pilot_instance_id = $1',
    [PILOT_A]
  );
  const beforeAuditCount = await countRowsAsSuperuser(
    'governance_audit_log',
    "pilot_instance_id = $1 AND event_type = 'memory.created'",
    [PILOT_A]
  );

  const created = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    (ctx) =>
      ctx.insertPrivateMemory({
        content: 'a freshly created private memory',
        provenance: 'USER_STATED',
      })
  );
  assert.match(created.id, /^[0-9a-f-]{36}$/);

  const afterMemCount = await countRowsAsSuperuser(
    'memory_store',
    'pilot_instance_id = $1',
    [PILOT_A]
  );
  const afterAuditCount = await countRowsAsSuperuser(
    'governance_audit_log',
    "pilot_instance_id = $1 AND event_type = 'memory.created'",
    [PILOT_A]
  );
  assert.equal(afterMemCount, beforeMemCount + 1);
  assert.equal(afterAuditCount, beforeAuditCount + 1);

  // The audit row carries the new memory id, the actor, and the
  // outcome — never the content.
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(
      "SELECT memory_id, actor_user_id, actor_role, outcome FROM governance_audit_log "
        + "WHERE event_type = 'memory.created' AND memory_id = $1",
      [created.id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].actor_user_id, SENIOR_A);
    assert.equal(r.rows[0].actor_role, 'senior');
    assert.equal(r.rows[0].outcome, 'allowed');
  } finally {
    await su.end();
  }
});

// Scenario 8.
test('memory-governance: the inserted memory has visibility_level=private, admissibility_state=admissible, owning_user_id=app.user_id', async () => {
  const created = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    (ctx) =>
      ctx.insertPrivateMemory({
        content: 'another private memory',
        provenance: 'USER_STATED',
      })
  );
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(
      'SELECT owning_user_id, visibility_level, admissibility_state, vault_id, active FROM memory_store WHERE id = $1',
      [created.id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].owning_user_id, SENIOR_A);
    assert.equal(r.rows[0].visibility_level, 'private');
    assert.equal(r.rows[0].admissibility_state, 'admissible');
    assert.equal(r.rows[0].vault_id, null);
    assert.equal(r.rows[0].active, true);
  } finally {
    await su.end();
  }
});

// Scenario 9 (audit-failure rollback).
test('memory-governance: a throw after insertPrivateMemory rolls BOTH the memory and audit INSERTs back (atomicity)', async () => {
  const beforeMemCount = await countRowsAsSuperuser(
    'memory_store',
    'pilot_instance_id = $1',
    [PILOT_A]
  );
  const beforeAuditCount = await countRowsAsSuperuser(
    'governance_audit_log',
    "pilot_instance_id = $1 AND event_type = 'memory.created'",
    [PILOT_A]
  );

  await assert.rejects(
    () =>
      withMemoryContext(
        appPool,
        { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
        async (ctx) => {
          await ctx.insertPrivateMemory({
            content: 'this memory must never be committed',
            provenance: 'USER_STATED',
          });
          throw new Error('simulated post-insert failure');
        }
      ),
    /simulated post-insert failure/
  );

  const afterMemCount = await countRowsAsSuperuser(
    'memory_store',
    'pilot_instance_id = $1',
    [PILOT_A]
  );
  const afterAuditCount = await countRowsAsSuperuser(
    'governance_audit_log',
    "pilot_instance_id = $1 AND event_type = 'memory.created'",
    [PILOT_A]
  );
  assert.equal(afterMemCount, beforeMemCount, 'memory row must have been rolled back');
  assert.equal(afterAuditCount, beforeAuditCount, 'audit row must have been rolled back');
});

// Scenario 10 (cross-user INSERT impersonation).
test('memory-governance: cross-user INSERT impersonation is blocked by RLS — owning_user_id is set from app.user_id, not from caller input', async () => {
  // The public API derives owning_user_id from sessionCtx.userId, so
  // there is no caller-facing way to pass a different owner. We
  // simulate the misconfigured-caller scenario by setting userId to
  // FAMILY_A while inserting (as expected by the design); the INSERT
  // succeeds for the family user's OWN row but never spoofs SENIOR_A.
  const created = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: FAMILY_A, userRole: 'family' },
    (ctx) =>
      ctx.insertPrivateMemory({
        content: 'family-A inserts their own memory',
        provenance: 'USER_STATED',
      })
  );
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(
      'SELECT owning_user_id FROM memory_store WHERE id = $1',
      [created.id]
    );
    assert.equal(r.rows[0].owning_user_id, FAMILY_A, 'owner must be the connecting user, never spoofable');
  } finally {
    await su.end();
  }

  // Now prove the WITH CHECK policy by attempting an impersonating
  // raw INSERT: connect with the lylo_app URL, set session vars for
  // FAMILY_A, and try to INSERT a row owned by SENIOR_A. RLS rejects.
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', FAMILY_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'family']);
    await assert.rejects(
      () =>
        raw.query(
          'INSERT INTO memory_store (pilot_instance_id, owning_user_id, content, provenance) '
            + "VALUES ($1, $2, 'spoofed', 'USER_STATED')",
          [PILOT_A, SENIOR_A]
        ),
      /row.level security|new row violates row.level/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

// Scenario 11 (lylo_app denied on config tables).
test('memory-governance: lylo_app cannot INSERT into config tables — defense in depth at the GRANT layer', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    for (const stmt of [
      "INSERT INTO pilot_instances (org_name) VALUES ('rogue')",
      "INSERT INTO users (pilot_instance_id, username, role) "
        + "VALUES ('11111111-1111-1111-1111-111111111111', 'rogue', 'senior')",
      'INSERT INTO companion_profile (pilot_instance_id, companion_name) '
        + "VALUES ('11111111-1111-1111-1111-111111111111', 'Rogue')",
    ]) {
      await assert.rejects(
        () => raw.query(stmt),
        /permission denied|row.level security|new row violates row.level/i,
        `lylo_app must be unable to execute: ${stmt}`
      );
    }
  } finally {
    await raw.end();
  }
});

// Scenario 12 (LOGIN role posture — lylo_app_login must NOT carry BYPASSRLS).
test('memory-governance: lylo_app_login does NOT have BYPASSRLS — RLS is engaged in production paths', async () => {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'lylo_app_login'"
    );
    assert.equal(r.rows.length, 1, 'lylo_app_login role must exist');
    assert.equal(r.rows[0].rolbypassrls, false, 'lylo_app_login MUST NOT have BYPASSRLS');
  } finally {
    await su.end();
  }
});
