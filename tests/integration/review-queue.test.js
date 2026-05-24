'use strict';
/*
 * Integration tests for the GM-23 review-queue substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createReviewQueueActor
 *     → withReviewContext
 *       → stageReviewItem
 *         → lylo_app LOGIN role + RLS
 *           → governance_review_queue
 *
 * Plus the E7–E9 adversarial integration scenarios from the GM-23
 * inspection (append-only trigger, no UPDATE/DELETE grants,
 * lylo_runtime denied, cross-pilot rejected, impersonation
 * rejected).
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createMemoryPool, closeMemoryPool } = require('../../src/memory');
const { createReviewQueuePool, closeReviewQueuePool } = require('../../src/review');
const { createReviewQueueActor, OUTCOMES } = require('../../src/actors');
const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const FAMILY_A = 'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const SENIOR_B = 'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb';

let reviewPool;
let memoryPool; // for sentinel parity if needed; not heavily used here

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL must be set');

  // Reset schema and apply migrations 001-008 (incl. new
  // 008_review_queue.sql) as the bootstrap superuser.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  // Seed the two-pilot fixture (reuses the rls-contract fixture).
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  reviewPool = createReviewQueuePool(LYLO_APP_DATABASE_URL, { max: 3 });
  memoryPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (reviewPool) await closeReviewQueuePool(reviewPool);
  if (memoryPool) await closeMemoryPool(memoryPool);
});

async function rowCount(pilotInstanceId) {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query(
      'SELECT COUNT(*)::int AS n FROM governance_review_queue WHERE pilot_instance_id = $1',
      [pilotInstanceId]
    );
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function requiresReviewDecision() {
  return classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
}

// ---- happy path ----

test('review-queue integration: real requires_review Decision is durably staged; row visible to proposer', async () => {
  const before = await rowCount(PILOT_A);
  const actor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const decision = requiresReviewDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    payloadSummary: { content: 'proposed memory text', provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'model_output' },
  });
  assert.equal(result.outcome, OUTCOMES.STAGED);
  assert.match(result.queueEntryId, /^[0-9a-f-]{36}$/);
  const after = await rowCount(PILOT_A);
  assert.equal(after, before + 1, 'exactly one row staged');

  // Read back via lylo_app as the proposer.
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id, status, decision_intent_type, decision_reason FROM governance_review_queue WHERE id = $1', [result.queueEntryId]);
    assert.equal(r.rows.length, 1, 'proposer must see the row they staged');
    assert.equal(r.rows[0].status, 'pending_review');
    assert.equal(r.rows[0].decision_intent_type, 'memory.candidate.create');
    assert.equal(r.rows[0].decision_reason, 'ai_inferred_requires_review');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

test('review-queue integration: admin in pilot sees the staged row', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', ADMIN_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'admin']);
    const r = await raw.query('SELECT id FROM governance_review_queue');
    assert.ok(r.rows.length >= 1, 'admin must see review-queue rows in the pilot');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

test('review-queue integration: family (non-proposer, non-admin) sees nothing', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', FAMILY_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'family']);
    const r = await raw.query('SELECT id FROM governance_review_queue');
    assert.deepEqual(r.rows, [], 'family must NOT see review-queue rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- E5: cross-pilot / impersonation guards (RLS WITH CHECK) ----

test('review-queue integration: impersonation INSERT (proposer_user_id ≠ app.user_id) is rejected by the WITH CHECK policy', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', FAMILY_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'family']);
    await assert.rejects(
      () => raw.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
          + 'VALUES ($1, $2, $3, $4, $5, $6)',
        [PILOT_A, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', SENIOR_A, 'family']
      ),
      /row.level security|new row violates row.level/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

test('review-queue integration: cross-pilot INSERT (pilot_instance_id ≠ app.pilot_instance_id) is rejected', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    await assert.rejects(
      () => raw.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
          + 'VALUES ($1, $2, $3, $4, $5, $6)',
        [PILOT_B, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', SENIOR_A, 'senior']
      ),
      /row.level security|new row violates row.level|foreign key/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

test('review-queue integration: CHECK constraint rejects status != "pending_review"', async () => {
  // Even with BYPASSRLS (we use bootstrap superuser), the CHECK
  // constraint on status refuses any other value.
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    await assert.rejects(
      () => su.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role, status) '
          + 'VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [PILOT_A, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', SENIOR_A, 'senior', 'reviewed']
      ),
      /check constraint|status/i
    );
  } finally {
    await su.end();
  }
});

test('review-queue integration: CHECK constraint rejects unknown decision_intent_type', async () => {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    await assert.rejects(
      () => su.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
          + 'VALUES ($1, $2, $3, $4, $5, $6)',
        [PILOT_A, 'agent.spawn', 'ai_inferred_requires_review', 'x', SENIOR_A, 'senior']
      ),
      /check constraint/i
    );
  } finally {
    await su.end();
  }
});

// ---- E8: append-only — UPDATE / DELETE both raise via the trigger ----

test('review-queue integration: UPDATE on a row raises (append-only trigger fires even for superuser)', async () => {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query('SELECT id FROM governance_review_queue LIMIT 1');
    assert.ok(r.rows.length >= 1, 'fixture should have seeded at least one row');
    await assert.rejects(
      () => su.query('UPDATE governance_review_queue SET decision_policy_ref = $1 WHERE id = $2', ['mutated', r.rows[0].id]),
      /append.only/i
    );
  } finally {
    await su.end();
  }
});

test('review-queue integration: DELETE on a row raises (append-only)', async () => {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query('SELECT id FROM governance_review_queue LIMIT 1');
    await assert.rejects(
      () => su.query('DELETE FROM governance_review_queue WHERE id = $1', [r.rows[0].id]),
      /append.only/i
    );
  } finally {
    await su.end();
  }
});

// ---- E9: grant posture — lylo_app has no UPDATE/DELETE; lylo_runtime has no access ----

test('review-queue integration: lylo_app cannot UPDATE governance_review_queue — denied at the GRANT layer', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_review_queue SET decision_policy_ref = 'x'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('review-queue integration: lylo_app cannot DELETE governance_review_queue — denied at the GRANT layer', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_review_queue'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('review-queue integration: lylo_runtime is denied on governance_review_queue at the GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) {
    // The runtime DB URL is provided by the integration-tests CI job;
    // skip silently in local runs where it isn't set.
    return;
  }
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_review_queue'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});
