'use strict';

/*
 * RLS / privacy contract — real-schema proof.
 *
 * The synthetic suite (run-contract.js) validates the policies against
 * a generic schema. This file runs the same matrix against the REAL
 * db/migrations/ schema after applying 007_rls_policies.sql. If the
 * real-schema migrations diverge from the synthetic contract — a new
 * table without a policy, a column rename that breaks a policy, an
 * accidentally-disabled RLS — the matrix fails.
 *
 * Bootstrapping:
 *   1. DROP / CREATE the public schema.
 *   2. Apply db/migrations/0*.sql in number order — this includes the
 *      new 007_rls_policies.sql that creates roles, enables RLS, and
 *      installs the policies.
 *   3. Apply tests/rls-contract/fixtures.sql as the bootstrap
 *      superuser (which BYPASSes RLS), seeding the two-pilot data.
 *      The synthetic fixture INSERTs use named columns only; the real
 *      schema's additional columns (created_at, updated_at, etc.) take
 *      their defaults.
 *   4. Run the same visibility / write / default-deny matrix as the
 *      synthetic runner, but against rows in the real schema.
 *
 * Requires DATABASE_URL pointing at a Postgres 16 service container.
 * The runner DROPS and recreates the public schema; it must never be
 * pointed at a real instance database.
 */

const test = require('node:test');
const before = test.before;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const DIR = __dirname;
const REAL_MIGRATIONS_DIR = path.join(DIR, '..', '..', 'db', 'migrations');

// Identifiers from fixtures.sql.
const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';

const SENIOR_A    = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const FAMILY_A    = 'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa';
const CAREGIVER_A = 'aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa';
const ADMIN_A     = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';

const SENIOR_B    = 'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb';

const MEM_A_PRIVATE         = 'aaaaaaaa-cccc-1111-1111-100000000001';
const MEM_A_FAMILY_SHARED   = 'aaaaaaaa-cccc-1111-1111-100000000002';
const MEM_A_PASSWORD_LOCKED = 'aaaaaaaa-cccc-1111-1111-100000000003';
const MEM_A_INADMISSIBLE    = 'aaaaaaaa-cccc-1111-1111-100000000004';
const MEM_B_PRIVATE         = 'bbbbbbbb-cccc-2222-2222-200000000001';

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set for the real-schema RLS contract suite');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const migrationFiles = fs.readdirSync(REAL_MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of migrationFiles) {
    await client.query(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, f), 'utf8'));
  }

  // Fixtures applied as the bootstrap superuser (BYPASSRLS by default).
  await client.query(fs.readFileSync(path.join(DIR, 'fixtures.sql'), 'utf8'));
  await client.end();
});

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return name;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function withContext(client, ctx, fn) {
  await client.query('BEGIN');
  try {
    if (ctx.role) {
      await client.query(`SET LOCAL ROLE ${quoteIdent(ctx.role)}`);
    }
    if (ctx.pilot) {
      await client.query(`SET LOCAL app.pilot_instance_id = ${quoteLiteral(ctx.pilot)}`);
    }
    if (ctx.user) {
      await client.query(`SET LOCAL app.user_id = ${quoteLiteral(ctx.user)}`);
    }
    if (ctx.userRole) {
      await client.query(`SET LOCAL app.user_role = ${quoteLiteral(ctx.userRole)}`);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function visibleIds(client, table, idColumn) {
  const r = await client.query(`SELECT ${quoteIdent(idColumn)} AS id FROM ${quoteIdent(table)}`);
  return r.rows.map((row) => row.id);
}

let clientRef = null;

async function setup() {
  if (clientRef) return clientRef;
  clientRef = new Client({ connectionString: DATABASE_URL });
  await clientRef.connect();
  return clientRef;
}

test.after(async () => {
  if (clientRef) {
    try { await clientRef.end(); } catch { /* ignore */ }
    clientRef = null;
  }
});

// ---------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------

test('real-schema: cross-pilot — senior-A sees no rows from pilot B', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const pilots = await visibleIds(client, 'pilot_instances', 'id');
    assert.deepEqual(pilots.sort(), [PILOT_A]);

    const memories = await visibleIds(client, 'memory_store', 'id');
    assert.equal(memories.includes(MEM_B_PRIVATE), false, 'must not see pilot B memory');

    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('real-schema: cross-pilot — admin-A cannot see pilot B audit log', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const events = await visibleIds(client, 'governance_audit_log', 'pilot_instance_id');
    assert.ok(events.every((p) => p === PILOT_A), `admin-A must not see pilot B events; got ${events}`);
  });
});

// ---------------------------------------------------------------------
// memory_store visibility matrix
// ---------------------------------------------------------------------

test('real-schema: memory_store — senior-A sees all of own memories', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    for (const expected of [
      MEM_A_PRIVATE, MEM_A_FAMILY_SHARED, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE,
    ]) {
      assert.ok(ids.includes(expected), `senior-A must see ${expected}`);
    }
  });
});

test('real-schema: memory_store — family-A sees only admissible family_shared', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
    assert.equal(ids.includes(MEM_A_PRIVATE), false);
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
    assert.equal(ids.includes(MEM_A_INADMISSIBLE), false);
  });
});

test('real-schema: memory_store — caregiver-A (no family_shared perm) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

test('real-schema: memory_store — admin-A sees no private rows (OQ-14.2)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PRIVATE), false);
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
  });
});

// ---------------------------------------------------------------------
// password_locked vault-session model
// ---------------------------------------------------------------------

test('real-schema: memory_store — senior-A sees password_locked with open session', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.ok(ids.includes(MEM_A_PASSWORD_LOCKED));
  });
});

test('real-schema: memory_store — family-A cannot see password_locked', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
  });
});

// ---------------------------------------------------------------------
// Vault + session tables
// ---------------------------------------------------------------------

test('real-schema: memory_vaults — only owner sees vault row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.equal(ids.length, 1);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.deepEqual(ids, [], 'family must not see senior vault');
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.deepEqual(ids, [], 'admin must not see vault content');
  });
});

test('real-schema: memory_vault_sessions — only owner sees sessions', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vault_sessions', 'id');
    assert.equal(ids.length, 2);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vault_sessions', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// circle_contacts
// ---------------------------------------------------------------------

test('real-schema: circle_contacts — senior sees own circle; family sees only own row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT contact_user_id FROM circle_contacts');
    const contactIds = r.rows.map((row) => row.contact_user_id).sort();
    assert.deepEqual(contactIds, [FAMILY_A, CAREGIVER_A].sort());
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const r = await client.query('SELECT contact_user_id FROM circle_contacts');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contact_user_id, FAMILY_A);
  });
});

// ---------------------------------------------------------------------
// governance_audit_log
// ---------------------------------------------------------------------

test('real-schema: governance_audit_log — admin sees all in-pilot events', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const r = await client.query('SELECT pilot_instance_id FROM governance_audit_log');
    assert.ok(r.rows.length >= 1);
    assert.ok(r.rows.every((row) => row.pilot_instance_id === PILOT_A));
  });
});

test('real-schema: governance_audit_log — user sees events targeted at them', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT target_user_id FROM governance_audit_log');
    assert.ok(r.rows.every((row) => row.target_user_id === SENIOR_A));
  });
});

// ---------------------------------------------------------------------
// Role-based table grants (defense-in-depth)
// ---------------------------------------------------------------------

test('real-schema: lylo_runtime — SELECT on memory_store is permission-denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM memory_store'),
      /permission denied/i,
      'lylo_runtime must be denied at the table grant level'
    );
  });
});

test('real-schema: lylo_runtime — SELECT on the four config tables works', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('real-schema: lylo_runtime — bootstrap policy lets it list pilot_instances without app.pilot_instance_id', async () => {
  // OQ-15.2 belt-and-suspenders: the role-scoped bootstrap policy
  // gives lylo_runtime unconditional SELECT on pilot_instances so a
  // future env-first GM-16 boot can resolve its pilot id.
  const c = await setup();
  await withContext(c, { role: 'lylo_runtime' /* no app.* set */ }, async (client) => {
    const r = await client.query('SELECT id FROM pilot_instances');
    const ids = r.rows.map((row) => row.id).sort();
    assert.deepEqual(ids, [PILOT_A, PILOT_B].sort(),
      'lylo_runtime bootstrap policy must expose all pilots regardless of session vars');
  });
});

// ---------------------------------------------------------------------
// Write rules
// ---------------------------------------------------------------------

test('real-schema: memory_store INSERT — cannot insert a memory owned by another user', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO memory_store (pilot_instance_id, owning_user_id, content, provenance) '
          + "VALUES ($1, $2, 'rogue', 'USER_STATED')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT for another owning_user_id must be blocked by the WITH CHECK policy'
    );
  });
});

test('real-schema: governance_audit_log INSERT — actor_user_id must match the connecting user', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_audit_log (pilot_instance_id, event_type, actor_user_id, actor_role, outcome) '
          + "VALUES ($1, 'memory.created', $2, 'senior', 'allowed')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT impersonating another actor must be blocked'
    );
  });
});

// ---------------------------------------------------------------------
// Default-deny
// ---------------------------------------------------------------------

test('real-schema: default-deny — lylo_app with no session-variable context sees no rows', async () => {
  const c = await setup();
  await withContext(c, { role: 'lylo_app' /* no pilot / user / role set */ }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// governance_review_queue (GM-23) — real-schema mirror of the synthetic
// proposer/admin/non-visibility matrix.
// ---------------------------------------------------------------------

const REVIEW_A = 'aaaaaaaa-eeee-1111-1111-700000000001';
const REVIEW_B = 'bbbbbbbb-eeee-2222-2222-700000000001';

test('real-schema: governance_review_queue — senior proposer sees own row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A));
    assert.equal(ids.includes(REVIEW_B), false);
  });
});

test('real-schema: governance_review_queue — admin in pilot sees all rows', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A));
    assert.equal(ids.includes(REVIEW_B), false);
  });
});

test('real-schema: governance_review_queue — family/caregiver see nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_queue', 'id'), []);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_queue', 'id'), []);
  });
});

test('real-schema: governance_review_queue — lylo_runtime is denied at the GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_queue'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_review_queue INSERT — impersonation rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
          + "VALUES ($1, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $2, 'senior')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('real-schema: governance_review_queue append-only — UPDATE raises (trigger fires for superuser)', async () => {
  // The contract suite connects as superuser (DROP+CREATE schema in
  // `before`). The append-only trigger fires regardless of role, so
  // the UPDATE attempt here raises.
  const c = await setup();
  // Use the superuser client outside withContext (no SET LOCAL ROLE).
  await assert.rejects(
    () => c.query('UPDATE governance_review_queue SET decision_policy_ref = $1 WHERE id = $2', ['mutated', REVIEW_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_review_decisions (GM-24) — real-schema RLS, append-only
// trigger, self-review BEFORE-INSERT trigger.
// ---------------------------------------------------------------------

const DECISION_A = 'aaaaaaaa-dddd-1111-1111-800000000001';
const DECISION_B = 'bbbbbbbb-dddd-2222-2222-800000000001';

test('real-schema: governance_review_decisions — admin in pilot sees all rows', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A));
    assert.equal(ids.includes(DECISION_B), false, 'admin must not see pilot-B decisions');
  });
});

test('real-schema: governance_review_decisions — proposer of underlying queue item sees the outcome', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'proposer must see outcome of their staged item');
    assert.equal(ids.includes(DECISION_B), false);
  });
});

test('real-schema: governance_review_decisions — family / caregiver see nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_decisions', 'id'), []);
  });
});

test('real-schema: governance_review_decisions — lylo_runtime is denied at the GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_decisions'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_review_decisions INSERT — non-admin rejected (by WITH CHECK, by self-review trigger, or by RLS-narrowed queue lookup)', async () => {
  // Defense in depth: the BEFORE-INSERT trigger fires before
  // RLS WITH CHECK. Under a non-admin role context the trigger's
  // SELECT on governance_review_queue is narrowed by queue RLS,
  // so the trigger may raise "not found" before WITH CHECK gets
  // a chance to reject. If the user happens to also be the
  // proposer, the trigger raises "self-review forbidden".
  // Any of these is an acceptable rejection of the non-admin path.
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', SENIOR_A]
      ),
      /row.level security|new row violates row.level|self-review forbidden|review_queue row .* not found/i
    );
  });
});

test('real-schema: governance_review_decisions INSERT — self-review rejected by BEFORE-INSERT trigger', async () => {
  // The trigger fires regardless of role. Use superuser (bypasses
  // RLS) so we hit the trigger directly; insert a decision where
  // reviewer_user_id == the queue row's proposer_user_id.
  const c = await setup();
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_review_decisions '
        + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
      // REVIEW_A_2 staged by SENIOR_A — same user tries to review.
      [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', SENIOR_A]
    ),
    /self-review forbidden/i
  );
});

test('real-schema: governance_review_decisions INSERT — duplicate review (UNIQUE) rejected', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // REVIEW_A already has DECISION_A seeded; second insert fails UNIQUE.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'rejected', 'rejected_admin_review')",
        [PILOT_A, REVIEW_A, ADMIN_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_review_decisions append-only — UPDATE raises (trigger fires for superuser)', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('UPDATE governance_review_decisions SET review_reason = $1 WHERE id = $2', ['mutated', DECISION_A]),
    /append.only/i
  );
});

test('real-schema: governance_review_decisions append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_review_decisions WHERE id = $1', [DECISION_A]),
    /append.only/i
  );
});
