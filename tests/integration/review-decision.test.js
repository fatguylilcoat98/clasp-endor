'use strict';
/*
 * Integration tests for the GM-24 review-decision substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createReviewDecisionActor
 *     → withReviewContext
 *       → recordReviewDecision
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_review_decisions
 *
 * Plus the read surface (listPendingReviewItems +
 * inspectReviewItem) and the F-series adversarial integration
 * scenarios (self-review trigger, double-review UNIQUE,
 * cross-pilot rejection, admin-only INSERT WITH CHECK,
 * append-only enforcement, GRANT denial for lylo_runtime).
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createReviewQueuePool, closeReviewQueuePool, withReviewContext } = require('../../src/review');
const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createReviewQueueActor,
  createReviewDecisionActor,
  OUTCOMES,
} = require('../../src/actors');

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

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL must be set');

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
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  reviewPool = createReviewQueuePool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (reviewPool) await closeReviewQueuePool(reviewPool);
});

async function rowCount() {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_review_decisions');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function reviewDecideDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
}

// We need a freshly-staged queue item to review (so we don't
// collide with the fixture-seeded REVIEW_A which is already
// reviewed). Stage one as senior-A via the review-queue actor;
// admin-A then records the outcome.
async function stageFreshQueueItem({ pilotInstanceId, userId, userRole, payloadHint }) {
  const stagingActor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  const r = await stagingActor.execute(requires, {
    pilotInstanceId,
    userId,
    userRole,
    payloadSummary: { content: payloadHint || 'fresh integration candidate', provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'integration' },
  });
  return r.queueEntryId;
}

// ---- happy path ----

test('review-decision integration: real admin records an approved outcome; row visible to admin and proposer; pending queue items reflect the new state', async () => {
  const queueId = await stageFreshQueueItem({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior',
    payloadHint: 'happy-path candidate',
  });
  const before = await rowCount();
  const actor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decision = reviewDecideDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN_A,
    userRole: 'admin',
    reviewQueueId: queueId,
    reviewOutcome: 'approved',
    reviewReason: 'approved_admin_review',
  });
  assert.equal(result.outcome, OUTCOMES.RECORDED);
  assert.match(result.reviewDecisionId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  // Admin sees the new decision row.
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const pending = await ctx.listPendingReviewItems();
      // The freshly-staged item we just reviewed should NOT be in pending.
      assert.equal(pending.find((r) => r.id === queueId), undefined,
        'reviewed item must not appear in pending list');
    }
  );

  // Proposer (senior-A) sees the outcome via their proposer SELECT policy.
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    // Use a raw lylo_app connection (not the pool) to bind senior-A's
    // session context and verify the proposer SELECT policy lets
    // them see the new decision row.
    const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
    await raw.connect();
    try {
      await raw.query('BEGIN');
      await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
      await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
      await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
      const r = await raw.query(
        'SELECT id, review_outcome FROM governance_review_decisions WHERE review_queue_id = $1',
        [queueId]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].review_outcome, 'approved');
      await raw.query('COMMIT');
    } finally {
      await raw.end();
    }
  } finally {
    await su.end();
  }
});

// ---- F5 / F6 / F7 (DB-side adversarial counterparts) ----

test('review-decision integration: non-admin role rejected (either by RLS WITH CHECK or by BEFORE-INSERT trigger via RLS-narrowed queue lookup)', async () => {
  // Defense in depth: the BEFORE-INSERT trigger fires before RLS
  // WITH CHECK, and the trigger reads governance_review_queue
  // under the current role. A non-admin can't see the queue row
  // (queue's RLS narrows to proposer + admin), so the trigger
  // raises "review_queue row ... not found in pilot ..." before
  // the WITH CHECK gets a chance to reject for role mismatch.
  // Either error is an acceptable rejection of the non-admin path.
  const queueId = await stageFreshQueueItem({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior',
    payloadHint: 'non-admin attempt',
  });
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', FAMILY_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'family']);
    await assert.rejects(
      () => raw.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_A, queueId, FAMILY_A]
      ),
      /row.level security|new row violates row.level|review_queue row .* not found/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

test('review-decision integration: admin self-review rejected by BEFORE-INSERT trigger', async () => {
  // ADMIN_A stages a queue item, then tries to review it. The
  // trigger raises before the WITH CHECK has anything to say.
  // (Admin role + tenant + reviewer match all pass; the trigger
  // catches the proposer == reviewer collision.)
  const queueId = await stageFreshQueueItem({
    pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin',
    payloadHint: 'admin self-stage',
  });
  const actor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN_A,
      userRole: 'admin',
      reviewQueueId: queueId,
      reviewOutcome: 'approved',
      reviewReason: 'approved_admin_review',
    }),
    /self-review forbidden|review operation failed/i
  );
});

test('review-decision integration: duplicate review for the same queue item rejected (UNIQUE)', async () => {
  const queueId = await stageFreshQueueItem({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior',
    payloadHint: 'double-review candidate',
  });
  const actor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decision = reviewDecideDecision();
  // First review succeeds.
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN_A,
    userRole: 'admin',
    reviewQueueId: queueId,
    reviewOutcome: 'approved',
    reviewReason: 'approved_admin_review',
  });
  // Second review for the same queue item must fail UNIQUE.
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN_A,
      userRole: 'admin',
      reviewQueueId: queueId,
      reviewOutcome: 'rejected',
      reviewReason: 'rejected_duplicate',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('review-decision integration: cross-pilot review_queue_id rejected (composite FK + RLS)', async () => {
  // Stage a queue item in pilot B; try to record a decision for it
  // while operating in pilot A admin context.
  const queueIdB = await stageFreshQueueItem({
    pilotInstanceId: PILOT_B, userId: SENIOR_B, userRole: 'senior',
    payloadHint: 'cross-pilot candidate',
  });
  const actor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN_A,
      userRole: 'admin',
      reviewQueueId: queueIdB,
      reviewOutcome: 'approved',
      reviewReason: 'approved_admin_review',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed/i
  );
});

test('review-decision integration: lylo_app cannot UPDATE governance_review_decisions — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_review_decisions SET review_reason = 'mutated'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('review-decision integration: lylo_app cannot DELETE governance_review_decisions — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_review_decisions'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('review-decision integration: lylo_runtime denied on governance_review_decisions at the GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_review_decisions'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('review-decision integration: CHECK rejects review_outcome outside locked vocabulary', async () => {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    await assert.rejects(
      () => su.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'pending', 'approved_admin_review')",
        [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', ADMIN_A]
      ),
      /check constraint|review_outcome/i
    );
  } finally {
    await su.end();
  }
});

test('review-decision integration: listPendingReviewItems returns only items without a recorded decision', async () => {
  // The fixture seeded REVIEW_A (already reviewed) plus a pending
  // row aaaaaaaa-eeee-1111-1111-700000000002. We've also staged a
  // few more items during this test run. listPendingReviewItems
  // (admin context) must include the un-reviewed pending row and
  // exclude REVIEW_A.
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const pending = await ctx.listPendingReviewItems({ limit: 200 });
      const ids = pending.map((r) => r.id);
      assert.ok(
        ids.includes('aaaaaaaa-eeee-1111-1111-700000000002'),
        'seeded pending row must appear'
      );
      assert.equal(
        ids.includes('aaaaaaaa-eeee-1111-1111-700000000001'),
        false,
        'seeded already-reviewed row must NOT appear'
      );
    }
  );
});
