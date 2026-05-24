'use strict';

/*
 * RLS / privacy contract test matrix.
 *
 * Applies the synthetic schema + candidate policies + fixtures to a
 * throwaway Postgres, then asserts the visibility / write matrix from
 * the perspective of each role × user × tenant combination.
 *
 * Roles, IDs, and policy identifiers are kept in sync with
 * docs/governance/rls-privacy-contract.md.
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
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set for the RLS contract suite');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  // Apply synthetic schema, then fixtures (under superuser, RLS is
  // bypassed for INSERTs), then policies.
  await client.query(fs.readFileSync(path.join(DIR, 'synthetic-schema.sql'), 'utf8'));
  await client.query(fs.readFileSync(path.join(DIR, 'fixtures.sql'), 'utf8'));
  await client.query(fs.readFileSync(path.join(DIR, 'policies.sql'), 'utf8'));
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

// Run a function inside a transaction with a SET LOCAL role and
// session-variable context. The transaction is rolled back at the end
// so each scenario starts clean.
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

test('cross-pilot: senior-A sees no rows from pilot B in any table', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app',
    pilot: PILOT_A,
    user: SENIOR_A,
    userRole: 'senior',
  }, async (client) => {
    const pilots = await visibleIds(client, 'pilot_instances', 'id');
    assert.deepEqual(pilots.sort(), [PILOT_A]);

    const memories = await visibleIds(client, 'memory_store', 'id');
    assert.equal(memories.includes(MEM_B_PRIVATE), false, 'must not see pilot B memory');

    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('cross-pilot: admin-A cannot see pilot B audit log', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin',
    pilot: PILOT_A,
    user: ADMIN_A,
    userRole: 'admin',
  }, async (client) => {
    const events = await visibleIds(client, 'governance_audit_log', 'pilot_instance_id');
    assert.ok(events.every((p) => p === PILOT_A), `admin-A must not see pilot B events; got ${events}`);
  });
});

// ---------------------------------------------------------------------
// memory_store visibility matrix
// ---------------------------------------------------------------------

test('memory_store: senior-A sees all of own memories regardless of visibility', async () => {
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

test('memory_store: family-A sees only admissible family_shared of senior-A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
    assert.equal(ids.includes(MEM_A_PRIVATE), false, 'family must NOT see private');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'family must NOT see password_locked');
    assert.equal(ids.includes(MEM_A_INADMISSIBLE), false, 'family must NOT see inadmissible');
  });
});

test('memory_store: caregiver-A (no family_shared permission) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

test('memory_store: admin-A sees no private rows (OQ-14.2 enforced)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PRIVATE), false, 'admin must NOT see private memories');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'admin must NOT see password_locked');
  });
});

// ---------------------------------------------------------------------
// password_locked vault-session model
// ---------------------------------------------------------------------

test('memory_store: senior-A sees password_locked while own session is open', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.ok(ids.includes(MEM_A_PASSWORD_LOCKED));
  });
});

test('memory_store: family-A cannot see password_locked even with family_shared permission', async () => {
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

test('memory_vaults: only the owner sees their vault row', async () => {
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

test('memory_vault_sessions: only the owner sees their sessions', async () => {
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

test('circle_contacts: senior-A sees own circle; family-A sees only their own row', async () => {
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

test('governance_audit_log: admin-A sees all in-pilot events', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const r = await client.query('SELECT pilot_instance_id FROM governance_audit_log');
    assert.ok(r.rows.length >= 1);
    assert.ok(r.rows.every((row) => row.pilot_instance_id === PILOT_A));
  });
});

test('governance_audit_log: a user sees events targeted at them', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT target_user_id FROM governance_audit_log');
    assert.ok(r.rows.every((row) => row.target_user_id === SENIOR_A));
  });
});

// ---------------------------------------------------------------------
// Role-based table grants (defense-in-depth: lylo_runtime cannot
// access memory tables at all)
// ---------------------------------------------------------------------

test('lylo_runtime: SELECT on memory_store is permission-denied (no grant)', async () => {
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

test('lylo_runtime: SELECT on the four config tables works (tenant-scoped)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

// ---------------------------------------------------------------------
// Write rules — accidental cross-user write blocked
// ---------------------------------------------------------------------

test('memory_store INSERT: a user cannot insert a memory owned by another user', async () => {
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

test('governance_audit_log INSERT: actor_user_id must match the connecting user', async () => {
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
// Default-deny (no policy → zero rows)
// ---------------------------------------------------------------------

test('default-deny: lylo_app with no session-variable context sees no rows', async () => {
  const c = await setup();
  await withContext(c, { role: 'lylo_app' /* no pilot / user / role set */ }, async (client) => {
    // The policies' current_setting(..., true) returns NULL when unset,
    // so the comparison is NULL and the row is filtered out.
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// governance_review_queue (GM-23): proposer / admin / others visibility
// ---------------------------------------------------------------------

const REVIEW_A = 'aaaaaaaa-eeee-1111-1111-700000000001';
const REVIEW_B = 'bbbbbbbb-eeee-2222-2222-700000000001';

test('governance_review_queue: senior-A (proposer) sees own pending review item', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A), 'proposer must see own pending review row');
    assert.equal(ids.includes(REVIEW_B), false, 'proposer must NOT see pilot-B review row');
  });
});

test('governance_review_queue: admin-A sees all pending review items in pilot A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A), 'admin must see review-queue rows in pilot');
    assert.equal(ids.includes(REVIEW_B), false, 'admin must NOT see pilot-B review row');
  });
});

test('governance_review_queue: family-A (non-proposer, non-admin) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_queue: caregiver-A sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_queue: cross-pilot — senior-B sees only pilot-B review row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_B, user: SENIOR_B, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_B));
    assert.equal(ids.includes(REVIEW_A), false);
  });
});

test('governance_review_queue: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_queue'),
      /permission denied/i,
      'lylo_runtime must be denied at the GRANT layer'
    );
  });
});

test('governance_review_queue INSERT: cannot impersonate proposer_user_id', async () => {
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
      /row.level security|new row violates row.level/i,
      'INSERT impersonating another proposer must be blocked'
    );
  });
});

// ---------------------------------------------------------------------
// governance_review_decisions (GM-24): admin sees all in pilot;
// proposer sees the outcome of their own queue item; family /
// caregiver / runtime see nothing. INSERT requires admin role +
// tenant + no impersonation.
// ---------------------------------------------------------------------

const DECISION_A = 'aaaaaaaa-dddd-1111-1111-800000000001';
const DECISION_B = 'bbbbbbbb-dddd-2222-2222-800000000001';

test('governance_review_decisions: admin-A sees the recorded review decision in pilot A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'admin must see review-decision rows in pilot');
    assert.equal(ids.includes(DECISION_B), false, 'admin must NOT see pilot-B review decision');
  });
});

test('governance_review_decisions: senior-A (proposer of REVIEW_A) sees outcome of their queue item', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'proposer must see their own queue item outcome');
    assert.equal(ids.includes(DECISION_B), false, 'proposer must NOT see pilot-B review decision');
  });
});

test('governance_review_decisions: family-A sees nothing (not proposer, not admin)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_decisions: caregiver-A sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_decisions: cross-pilot — senior-B sees only pilot-B review decision', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_B, user: SENIOR_B, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids.sort(), [DECISION_B]);
  });
});

test('governance_review_decisions: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_decisions'),
      /permission denied/i,
      'lylo_runtime must be denied at the GRANT layer'
    );
  });
});

test('governance_review_decisions INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  // senior-A tries to insert a review decision for some other queue item.
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
      /row.level security|new row violates row.level/i,
      'non-admin INSERT must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: admin cannot impersonate another reviewer_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate FAMILY_A as reviewer (with admin role context).
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', FAMILY_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT impersonating a different reviewer_user_id must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // Try to record a decision for pilot B's queue row while
    // operating in pilot A's context. RLS WITH CHECK rejects the
    // pilot mismatch first.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_B, 'bbbbbbbb-eeee-2222-2222-700000000002', ADMIN_A]
      ),
      /row.level security|new row violates row.level|foreign key/i,
      'cross-pilot INSERT must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: duplicate review (UNIQUE on review_queue_id) rejected', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // REVIEW_A already has DECISION_A (seeded). Trying to file a
    // second one fails on the UNIQUE constraint.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'rejected', 'rejected_policy_violation')",
        [PILOT_A, REVIEW_A, ADMIN_A]
      ),
      /duplicate key|unique/i,
      'second review for same queue row must be rejected'
    );
  });
});
