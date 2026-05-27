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

// ---------------------------------------------------------------------
// governance_execution_authorizations (GM-25) — real-schema RLS,
// append-only trigger, preconditions BEFORE-INSERT trigger
// (review must be approved + authorizer != reviewer + scope ↔ intent).
// ---------------------------------------------------------------------

const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN2_B = 'bbbbbbbb-5555-2222-2222-bbbbbbbbbbbb';
const AUTH_A = 'aaaaaaaa-cccc-1111-1111-900000000001';
const AUTH_B = 'bbbbbbbb-cccc-2222-2222-900000000001';
const DECISION_A_2 = 'aaaaaaaa-dddd-1111-1111-800000000002';
const DECISION_B_2 = 'bbbbbbbb-dddd-2222-2222-800000000002';

test('real-schema: governance_execution_authorizations — admin sees authorization rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_authorizations', 'id');
    assert.ok(ids.includes(AUTH_A));
    assert.equal(ids.includes(AUTH_B), false);
  });
});

test('real-schema: governance_execution_authorizations — proposer / family / caregiver see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_authorizations', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_authorizations — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_authorizations'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_authorizations INSERT — self-authorization rejected by BEFORE-INSERT trigger', async () => {
  // Bypass RLS via superuser to hit the trigger directly. The
  // reviewer of DECISION_A_2 is ADMIN_A; inserting an authorization
  // by ADMIN_A for that decision triggers the self-authorization check.
  const c = await setup();
  // First need a never-authorized approved decision. Insert a fresh
  // one via superuser (RLS bypassed) so we don't collide with UNIQUE.
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000099991', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000099991',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000099991',
      ADMIN_A,
    ]
  );
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
      [PILOT_A, 'aaaaaaaa-dddd-1111-1111-800000099991', ADMIN_A]
    ),
    /self-authorization forbidden/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — authorizing a rejected review is rejected by trigger', async () => {
  // DECISION_B is rejected (per fixture). admin2-B tries to authorize it.
  const c = await setup();
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
      [PILOT_B, 'bbbbbbbb-dddd-2222-2222-800000000001', ADMIN2_B]
    ),
    /non-approved review|review_outcome/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — scope mismatch rejected by trigger', async () => {
  // DECISION_A_2's underlying intent is memory.candidate.create.
  // Try to authorize it with a non-matching scope. Use a fresh
  // unauthorized approved decision (DECISION_A_2 already has AUTH_A).
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000099992', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000099992',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000099992',
      ADMIN_A,
    ]
  );
  // Now try to authorize with the wrong scope.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'future_vault_action', 'admin_explicit_authorization')",
      [PILOT_A, 'aaaaaaaa-dddd-1111-1111-800000099992', ADMIN2_A]
    ),
    /does not match intent type/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — duplicate authorization for same review_decision rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN2_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_authorizations '
          + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
        [PILOT_A, DECISION_A_2, ADMIN2_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_authorizations append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_authorizations SET authorization_reason = 'admin_explicit_authorization' WHERE id = $1", [AUTH_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_authorizations append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_authorizations WHERE id = $1', [AUTH_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_claims (GM-26) — real-schema RLS,
// append-only trigger, BEFORE-INSERT preconditions trigger
// (authorization-exists + scope-equality + claimant-≠-authorizer +
// surface-↔-scope + review-still-approved).
// ---------------------------------------------------------------------

const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const CLAIM_A = 'aaaaaaaa-bbbb-1111-1111-a00000000001';
const CLAIM_B = 'bbbbbbbb-bbbb-2222-2222-b00000000001';
const AUTH_A_FOR_CLAIM = 'aaaaaaaa-cccc-1111-1111-900000000001';

test('real-schema: governance_execution_claims — admin sees claim rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_claims', 'id');
    assert.ok(ids.includes(CLAIM_A));
    assert.equal(ids.includes(CLAIM_B), false);
  });
});

test('real-schema: governance_execution_claims — proposer / family see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_claims', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_claims — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_claims'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_claims INSERT — self-claim rejected by BEFORE-INSERT trigger', async () => {
  // Bypass RLS via superuser to hit the trigger directly. AUTH_A
  // was authorized by ADMIN2_A; inserting a claim by ADMIN2_A
  // for the same authorization triggers the self-claim check.
  // First need a never-claimed authorization. Create a fresh
  // queue → review → authorization chain via superuser.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088881', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088881',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088881',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088881',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088881',
      ADMIN2_A,
    ]
  );
  // Now try to claim it as ADMIN2_A — same human who authorized.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088881', ADMIN2_A]
    ),
    /self-claim forbidden/i
  );
});

test('real-schema: governance_execution_claims INSERT — scope drift rejected by trigger', async () => {
  // Create a fresh authorization with scope memory_candidate_admission.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088882', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088882',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088882',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088882',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088882',
      ADMIN2_A,
    ]
  );
  // Try to claim with a DIFFERENT authorization_scope (drift).
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'future_vault_action', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088882', ADMIN3_A]
    ),
    /authorization_scope drift/i
  );
});

test('real-schema: governance_execution_claims INSERT — surface ↔ scope mismatch rejected by trigger', async () => {
  // Create a fresh authorization with scope memory_candidate_admission.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088883', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088883',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088883',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088883',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088883',
      ADMIN2_A,
    ]
  );
  // Now claim with MATCHING scope but WRONG surface.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088883', ADMIN3_A]
    ),
    /does not fit authorization_scope/i
  );
});

test('real-schema: governance_execution_claims INSERT — replay (duplicate claim) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN3_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_claims '
          + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, AUTH_A_FOR_CLAIM, ADMIN3_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_claims append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_claims SET execution_surface = 'future_memory_admission_consumer' WHERE id = $1", [CLAIM_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_claims append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_claims WHERE id = $1', [CLAIM_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_attempts (GM-27) — real-schema RLS,
// append-only trigger, BEFORE-INSERT preconditions trigger
// (claim-exists + scope-equality + surface-equality +
// attempter-≠-claimant + chain-walk-to-approved).
// Constitutional rule: ATTEMPT IS NOT OUTCOME.
// ---------------------------------------------------------------------

const ADMIN4_A = 'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa';
const ATTEMPT_A = 'aaaaaaaa-aaaa-1111-1111-c00000000001';
const ATTEMPT_B = 'bbbbbbbb-aaaa-2222-2222-d00000000001';
const CLAIM_A_FOR_ATTEMPT = 'aaaaaaaa-bbbb-1111-1111-a00000000001';

test('real-schema: governance_execution_attempts — admin sees attempt rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_attempts', 'id');
    assert.ok(ids.includes(ATTEMPT_A));
    assert.equal(ids.includes(ATTEMPT_B), false);
  });
});

test('real-schema: governance_execution_attempts — proposer / family see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_attempts', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_attempts — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_attempts'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_attempts INSERT — self-attempt rejected by BEFORE-INSERT trigger', async () => {
  // Build a fresh chain via superuser, with admin3 as claimant.
  // Then attempt to record an attempt by admin3 — same human as
  // the claimant — and confirm the trigger raises.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000077771', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000077771',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000077771',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000077771',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000077771',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000077771',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000077771',
      ADMIN3_A,
    ]
  );
  // Now try to attempt against the claim as ADMIN3_A (the claimant).
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_attempts '
        + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-bbbb-1111-1111-a00000077771', ADMIN3_A]
    ),
    /self-attempt forbidden/i
  );
});

test('real-schema: governance_execution_attempts INSERT — scope drift rejected by trigger', async () => {
  // Build a fresh chain. The claim's scope will be
  // memory_candidate_admission. The attempt will declare a
  // different scope and the trigger must raise.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000077772', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000077772',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000077772',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000077772',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000077772',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000077772',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000077772',
      ADMIN3_A,
    ]
  );
  // Attempt with a DIFFERENT scope.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_attempts '
        + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
        + "VALUES ($1, $2, 'future_vault_action', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-bbbb-1111-1111-a00000077772', ADMIN4_A]
    ),
    /authorization_scope drift/i
  );
});

test('real-schema: governance_execution_attempts INSERT — surface drift rejected by trigger', async () => {
  // Build a fresh chain. The attempt will match scope but declare
  // a different surface; the trigger must raise.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000077773', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000077773',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000077773',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000077773',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000077773',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000077773',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000077773',
      ADMIN3_A,
    ]
  );
  // Attempt with matching scope but a DIFFERENT surface — the
  // CHECK will reject the surface-scope pairing first (the CHECK
  // is satisfied because the surface is valid in vocabulary; the
  // trigger then catches the drift from the claim's surface).
  // But wait — `future_memory_admission_consumer` is the only
  // surface valid for memory_candidate_admission per the GM-26
  // claim trigger; here we're checking the GM-27 attempt
  // trigger's surface-equality check, so we pick a different
  // valid surface vocabulary value.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_attempts '
        + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-bbbb-1111-1111-a00000077773', ADMIN4_A]
    ),
    /execution_surface drift/i
  );
});

test('real-schema: governance_execution_attempts INSERT — replay (duplicate attempt) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN4_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_attempts '
          + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, CLAIM_A_FOR_ATTEMPT, ADMIN4_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_attempts append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_attempts SET execution_surface = 'future_memory_admission_consumer' WHERE id = $1", [ATTEMPT_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_attempts append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_attempts WHERE id = $1', [ATTEMPT_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_outcomes (GM-28) — real-schema RLS,
// append-only trigger, BEFORE-INSERT preconditions trigger
// (attempt-exists + scope-equality + surface-equality +
// recorder-≠-attempter + chain-walk-to-approved).
// Constitutional rule: AN OUTCOME ROW IS NOT TRUTH.
// ---------------------------------------------------------------------

const ADMIN5_A = 'aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa';
const OUTCOME_A = 'aaaaaaaa-9999-1111-1111-e00000000001';
const OUTCOME_B = 'bbbbbbbb-9999-2222-2222-f00000000001';
const ATTEMPT_A_FOR_OUTCOME = 'aaaaaaaa-aaaa-1111-1111-c00000000001';

test('real-schema: governance_execution_outcomes — admin sees outcome rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_outcomes', 'id');
    assert.ok(ids.includes(OUTCOME_A));
    assert.equal(ids.includes(OUTCOME_B), false);
  });
});

test('real-schema: governance_execution_outcomes — proposer / family see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_outcomes', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_outcomes — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_outcomes'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_outcomes INSERT — self-recording rejected by BEFORE-INSERT trigger', async () => {
  // Build a fresh chain via superuser, with admin4 as attempter.
  // Then try to record an outcome by admin4 — same human as the
  // attempter — and confirm the trigger raises.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000066661', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000066661',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000066661',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000066661',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000066661',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000066661',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000066661',
      ADMIN3_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_attempts '
      + '(id, pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-aaaa-1111-1111-c00000066661',
      PILOT_A,
      'aaaaaaaa-bbbb-1111-1111-a00000066661',
      ADMIN4_A,
    ]
  );
  // Now try to record an outcome as ADMIN4_A — same human who attempted.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_outcomes '
        + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_completed', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-aaaa-1111-1111-c00000066661', ADMIN4_A]
    ),
    /self-recording forbidden/i
  );
});

test('real-schema: governance_execution_outcomes INSERT — scope drift rejected by trigger', async () => {
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000066662', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000066662',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000066662',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000066662',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000066662',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000066662',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000066662',
      ADMIN3_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_attempts '
      + '(id, pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-aaaa-1111-1111-c00000066662',
      PILOT_A,
      'aaaaaaaa-bbbb-1111-1111-a00000066662',
      ADMIN4_A,
    ]
  );
  // Outcome with DIFFERENT scope from the attempt.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_outcomes '
        + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
        + "VALUES ($1, $2, 'future_vault_action', 'future_vault_action_consumer', 'reported_completed', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-aaaa-1111-1111-c00000066662', ADMIN5_A]
    ),
    /authorization_scope drift/i
  );
});

test('real-schema: governance_execution_outcomes INSERT — surface drift rejected by trigger', async () => {
  // Use the existing seeded attempt; try surface drift.
  // Need a fresh chain since the seeded attempt already has an outcome.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000066663', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000066663',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000066663',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000066663',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000066663',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000066663',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000066663',
      ADMIN3_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_attempts '
      + '(id, pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-aaaa-1111-1111-c00000066663',
      PILOT_A,
      'aaaaaaaa-bbbb-1111-1111-a00000066663',
      ADMIN4_A,
    ]
  );
  // Outcome with MATCHING scope but DIFFERENT surface.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_outcomes '
        + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_vault_action_consumer', 'reported_completed', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-aaaa-1111-1111-c00000066663', ADMIN5_A]
    ),
    /execution_surface drift/i
  );
});

test('real-schema: governance_execution_outcomes INSERT — replay (duplicate outcome) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN5_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_unknown', $3, 'admin')",
        [PILOT_A, ATTEMPT_A_FOR_OUTCOME, ADMIN5_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_outcomes append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_outcomes SET outcome_type = 'reported_unknown' WHERE id = $1", [OUTCOME_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_outcomes append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_outcomes WHERE id = $1', [OUTCOME_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_verifications (GM-29) — real-schema RLS,
// triggers, and constraints. The synthetic suite covers
// visibility; this suite covers the BEFORE-INSERT trigger
// (self-verification rejection, missing-outcome rejection, chain
// rot), replay UNIQUE, and append-only enforcement.
// Constitutional rule: VERIFICATION ≠ RECONCILIATION ≠ REPAIR.
// ---------------------------------------------------------------------

const ADMIN6_A = 'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa';
const VERIFICATION_A_SEEDED = 'aaaaaaaa-8888-1111-1111-100000000001';
const OUTCOME_A_SEEDED = 'aaaaaaaa-9999-1111-1111-e00000000001';

test('real-schema: governance_execution_verifications — admin sees verification rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_verifications', 'id');
    assert.ok(ids.includes(VERIFICATION_A_SEEDED), 'admin must see seeded VERIFICATION_A');
  });
});

test('real-schema: governance_execution_verifications — proposer / family see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_verifications', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_verifications — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_verifications'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_verifications INSERT — self-verification rejected by BEFORE-INSERT trigger', async () => {
  // Build a fresh chain via superuser, with admin5 as outcome
  // recorder. Then try to record a verification by admin5 — same
  // human as the recorder — and confirm the trigger raises.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000055551', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000055551',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000055551',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000055551',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000055551',
      ADMIN2_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_claims '
      + '(id, pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-bbbb-1111-1111-a00000055551',
      PILOT_A,
      'aaaaaaaa-cccc-1111-1111-900000055551',
      ADMIN3_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_attempts '
      + '(id, pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', $4, 'admin')",
    [
      'aaaaaaaa-aaaa-1111-1111-c00000055551',
      PILOT_A,
      'aaaaaaaa-bbbb-1111-1111-a00000055551',
      ADMIN4_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_outcomes '
      + '(id, pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
      + "VALUES ($1, $2, $3, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_completed', $4, 'admin')",
    [
      'aaaaaaaa-9999-1111-1111-e00000055551',
      PILOT_A,
      'aaaaaaaa-aaaa-1111-1111-c00000055551',
      ADMIN5_A,
    ]
  );
  // Now try to verify as ADMIN5_A — same human who recorded the outcome.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_verifications '
        + '(pilot_instance_id, execution_outcome_id, verified_by_user_id, verified_by_role, verification_type, verification_result) '
        + "VALUES ($1, $2, $3, 'admin', 'human_observation', 'verified_consistent')",
      [PILOT_A, 'aaaaaaaa-9999-1111-1111-e00000055551', ADMIN5_A]
    ),
    /self-verification forbidden/i
  );
});

test('real-schema: governance_execution_verifications INSERT — missing outcome rejected by trigger', async () => {
  const c = await setup();
  // Reference an outcome ID that does not exist in pilot A.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_verifications '
        + '(pilot_instance_id, execution_outcome_id, verified_by_user_id, verified_by_role, verification_type, verification_result) '
        + "VALUES ($1, $2, $3, 'admin', 'human_observation', 'verified_consistent')",
      [PILOT_A, '00000000-0000-0000-0000-000000000999', ADMIN6_A]
    ),
    /not found|foreign key/i
  );
});

test('real-schema: governance_execution_verifications INSERT — replay (duplicate verification) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN6_A, userRole: 'admin',
  }, async (client) => {
    // OUTCOME_A_SEEDED already has VERIFICATION_A_SEEDED.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_verifications '
          + '(pilot_instance_id, execution_outcome_id, verified_by_user_id, verified_by_role, verification_type, verification_result) '
          + "VALUES ($1, $2, $3, 'admin', 'system_log_review', 'verification_inconclusive')",
        [PILOT_A, OUTCOME_A_SEEDED, ADMIN6_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_verifications append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_verifications SET verification_result = 'verification_inconclusive' WHERE id = $1", [VERIFICATION_A_SEEDED]),
    /append.only/i
  );
});

test('real-schema: governance_execution_verifications append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_verifications WHERE id = $1', [VERIFICATION_A_SEEDED]),
    /append.only/i
  );
});

// =====================================================================
// Phase 2 — shared memory writes
//
// withContext() always ROLLBACKs at the end of the block, so we prove
// writes via RETURNING counts INSIDE the same withContext block, and
// prove RLS-narrowed reads by seeding rows as the bootstrap superuser
// (which BYPASSes RLS) and then opening the read withContext for the
// role under test.
// =====================================================================

test('real-schema: memory_store INSERT (family_shared) — lylo_app/senior can write it (succeeds, RETURNING row)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query(
      'INSERT INTO memory_store '
        + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
        + "VALUES ($1, $2, 'phase2-write-probe', 'USER_STATED', 'family_shared', 'admissible') "
        + 'RETURNING id, visibility_level',
      [PILOT_A, SENIOR_A]
    );
    assert.equal(r.rows.length, 1, 'family_shared INSERT must succeed under existing memory_store INSERT policy');
    assert.equal(r.rows[0].visibility_level, 'family_shared');
  });
});

test('real-schema: memory_store (family_shared, seeded) — family-A with grant sees it; caregiver-A without grant does not', async () => {
  const c = await setup();
  // Seed a new family_shared row as superuser so it persists past
  // withContext rollbacks.
  await c.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
      + "VALUES ($1, $2, 'phase2-seeded-family-shared', 'USER_STATED', 'family_shared', 'admissible')",
    [PILOT_A, SENIOR_A]
  );

  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const r = await client.query(
      "SELECT id FROM memory_store WHERE content = 'phase2-seeded-family-shared'"
    );
    assert.equal(r.rows.length, 1, 'family contact with family_shared grant must see the row');
  });

  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const r = await client.query(
      "SELECT id FROM memory_store WHERE content = 'phase2-seeded-family-shared'"
    );
    assert.equal(r.rows.length, 0, 'caregiver with empty visibility_levels must not see family_shared');
  });
});

test('real-schema: memory_store (family_shared, seeded in pilot A) — senior-B in pilot B sees nothing (cross-pilot)', async () => {
  const c = await setup();
  await c.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
      + "VALUES ($1, $2, 'phase2-cross-pilot-probe', 'USER_STATED', 'family_shared', 'admissible')",
    [PILOT_A, SENIOR_A]
  );
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_B, user: SENIOR_B, userRole: 'senior',
  }, async (client) => {
    const r = await client.query(
      "SELECT id FROM memory_store WHERE content = 'phase2-cross-pilot-probe'"
    );
    assert.equal(r.rows.length, 0, 'cross-pilot isolation holds even with family_shared tier');
  });
});

// =====================================================================
// Phase 3 — circle contacts management (migration 019 adds INSERT/UPDATE
// grants + policies)
// =====================================================================

// A user fixture used only for these tests. Pre-seeded as superuser so
// it exists across all Phase 3 tests regardless of withContext rollbacks.
const NEW_FAMILY_A = 'aaaaaaaa-bbbb-1111-1111-aaaaaaaaaaaa';

async function seedNewFamilyUser(c) {
  await c.query(
    'INSERT INTO users (id, pilot_instance_id, username, role) '
      + 'VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [NEW_FAMILY_A, PILOT_A, 'new-family@test.example', 'family']
  );
}

test('real-schema: circle_contacts INSERT — senior can add a row for themselves (RETURNING proves the policy permits)', async () => {
  const c = await setup();
  await seedNewFamilyUser(c);
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query(
      'INSERT INTO circle_contacts '
        + '(pilot_instance_id, senior_user_id, contact_user_id, permission_scope) '
        + "VALUES ($1, $2, $3, '{\"visibility_levels\":[]}'::jsonb) "
        + 'RETURNING id',
      [PILOT_A, SENIOR_A, NEW_FAMILY_A]
    );
    assert.equal(r.rows.length, 1, 'INSERT with senior_user_id = app.user_id must be permitted by the new policy');
  });
});

test('real-schema: circle_contacts INSERT — caller cannot claim a senior_user_id that is not themselves (WITH CHECK blocks it)', async () => {
  const c = await setup();
  await seedNewFamilyUser(c);
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO circle_contacts '
          + '(pilot_instance_id, senior_user_id, contact_user_id, permission_scope) '
          + "VALUES ($1, $2, $3, '{\"visibility_levels\":[\"family_shared\"]}'::jsonb)",
        [PILOT_A, SENIOR_A, NEW_FAMILY_A]
      ),
      /row.level security|new row violates row.level/i,
      'WITH CHECK must reject INSERT where senior_user_id != app.user_id'
    );
  });
});

test('real-schema: circle_contacts UPDATE — senior can update their own row (RETURNING proves the policy permits)', async () => {
  const c = await setup();
  // Update the fixture row: SENIOR_A -> FAMILY_A with family_shared.
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query(
      "UPDATE circle_contacts SET permission_scope = '{\"visibility_levels\":[]}'::jsonb "
        + 'WHERE pilot_instance_id = $1 AND senior_user_id = $2 AND contact_user_id = $3 '
        + 'RETURNING id',
      [PILOT_A, SENIOR_A, FAMILY_A]
    );
    assert.equal(r.rows.length, 1, 'senior must be able to update their own grant row');
  });
});

test('real-schema: circle_contacts UPDATE — a contact cannot rewrite the senior\'s grant row (zero rows updated)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    // FAMILY_A targets SENIOR_A's grant row. The UPDATE policy USING
    // clause requires senior_user_id = app.user_id; FAMILY_A is the
    // contact, not the senior, so RLS narrows the matched row set to
    // zero. RETURNING confirms.
    const r = await client.query(
      "UPDATE circle_contacts SET permission_scope = '{\"visibility_levels\":[]}'::jsonb "
        + 'WHERE senior_user_id = $1 AND contact_user_id = $2 '
        + 'RETURNING id',
      [SENIOR_A, FAMILY_A]
    );
    assert.equal(r.rows.length, 0, 'contact must not be able to rewrite the senior\'s grant row');
  });
});

test('real-schema: circle_contacts (empty scope, seeded) — contact sees no family_shared rows from that senior (default-deny)', async () => {
  const c = await setup();
  await seedNewFamilyUser(c);
  // Seed circle row + a family_shared memory as superuser so both
  // persist past withContext rollbacks.
  await c.query(
    "DELETE FROM circle_contacts WHERE senior_user_id = $1 AND contact_user_id = $2",
    [SENIOR_A, NEW_FAMILY_A]
  );
  await c.query(
    'INSERT INTO circle_contacts '
      + '(pilot_instance_id, senior_user_id, contact_user_id, permission_scope) '
      + "VALUES ($1, $2, $3, '{\"visibility_levels\":[]}'::jsonb)",
    [PILOT_A, SENIOR_A, NEW_FAMILY_A]
  );
  await c.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
      + "VALUES ($1, $2, 'phase3-default-deny-probe', 'USER_STATED', 'family_shared', 'admissible')",
    [PILOT_A, SENIOR_A]
  );

  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: NEW_FAMILY_A, userRole: 'family',
  }, async (client) => {
    const r = await client.query(
      "SELECT id FROM memory_store WHERE content = 'phase3-default-deny-probe'"
    );
    assert.equal(r.rows.length, 0, 'default-deny: empty visibility_levels grants no visibility');
  });
});

test('real-schema: circle_contacts (family_shared scope, seeded) — contact sees the senior\'s family_shared rows', async () => {
  const c = await setup();
  await seedNewFamilyUser(c);
  await c.query(
    "DELETE FROM circle_contacts WHERE senior_user_id = $1 AND contact_user_id = $2",
    [SENIOR_A, NEW_FAMILY_A]
  );
  await c.query(
    'INSERT INTO circle_contacts '
      + '(pilot_instance_id, senior_user_id, contact_user_id, permission_scope) '
      + "VALUES ($1, $2, $3, '{\"visibility_levels\":[\"family_shared\"]}'::jsonb)",
    [PILOT_A, SENIOR_A, NEW_FAMILY_A]
  );
  await c.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
      + "VALUES ($1, $2, 'phase3-grant-probe', 'USER_STATED', 'family_shared', 'admissible')",
    [PILOT_A, SENIOR_A]
  );

  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: NEW_FAMILY_A, userRole: 'family',
  }, async (client) => {
    const r = await client.query(
      "SELECT id FROM memory_store WHERE content = 'phase3-grant-probe'"
    );
    assert.equal(r.rows.length, 1, 'family_shared grant opens visibility of the senior\'s family_shared rows');
  });
});
