'use strict';
/*
 * Unit tests for the GM-24 review-decision actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_REVIEW_DECIDE intent
 * type added in GM-24). The review queue pool is mocked — no DB.
 *
 * Negative properties (forged Decisions, prototype tampering,
 * wrong-intent-type, non-admin role, sentinel leakage) live in the
 * dedicated adversarial suite at
 * tests/governance/adversarial.test.js (F-series, GM-24 additions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createReviewDecisionActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const QUEUE_ID = 'eeeeeeee-1111-2222-3333-eeeeeeeeeeee';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'dddddddd-1111-1111-1111-dddddddddddd', reviewed_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    connect: async () => { connectCalls += 1; return client; },
    getConnectCalls: () => connectCalls,
    getQueries: () => queries,
  };
}

function makeCapturingLogger() {
  const lines = [];
  return {
    lines,
    info(event, fields) {
      lines.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
    asJoinedText() { return lines.join('\n'); },
  };
}

function reviewDecideDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      reviewQueueId: QUEUE_ID,
      reviewOutcome: 'approved',
      reviewReason: 'approved_admin_review',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createReviewDecisionActor: rejects missing options', () => {
  assert.throws(() => createReviewDecisionActor(), /options object is required/);
  assert.throws(() => createReviewDecisionActor(null), /options object is required/);
});

test('createReviewDecisionActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createReviewDecisionActor({}), /reviewQueuePool is required/);
});

test('createReviewDecisionActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.review.decide as admissible', () => {
  const d = reviewDecideDecision();
  assert.equal(d.intentType, 'governance.review.decide');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'review_decision_recording_permitted');
  assert.match(d.policyRef, /review-decision-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin review_decide Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.RECORDED);
  assert.equal(result.outcome, 'recorded');
  assert.equal(result.decision, decision);
  assert.match(result.reviewDecisionId, /^[0-9a-f-]{36}$/);
  assert.ok(result.reviewedAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_review_decisions/);
});

test('execute: works for the rejected outcome too', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  const result = await actor.execute(decision, baseParams({
    reviewOutcome: 'rejected',
    reviewReason: 'rejected_policy_violation',
  }));
  assert.equal(result.outcome, OUTCOMES.RECORDED);
  assert.equal(pool.getConnectCalls(), 1);
});

test('execute: a single Decision instance can be reused across reviews of different queue items', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  const result1 = await actor.execute(decision, baseParams());
  const result2 = await actor.execute(decision, baseParams({
    reviewQueueId: 'ffffffff-2222-3333-4444-ffffffffffff',
    reviewOutcome: 'rejected',
    reviewReason: 'rejected_duplicate',
  }));
  assert.equal(result1.outcome, OUTCOMES.RECORDED);
  assert.equal(result2.outcome, OUTCOMES.RECORDED);
});

// ---- vocabulary validation ----

test('execute: rejects unknown reviewOutcome', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ reviewOutcome: 'maybe' })),
    /reviewOutcome must be one of/
  );
  assert.equal(pool.getConnectCalls(), 0, 'pool must not be consulted on validation failure');
});

test('execute: rejects unknown reviewReason', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ reviewReason: 'because' })),
    /reviewReason must be one of/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID reviewQueueId', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ reviewQueueId: 'not-a-uuid' })),
    /reviewQueueId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID pilotInstanceId', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ pilotInstanceId: 'x' })),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects missing params', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = reviewDecideDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary review_outcome and review_reason DO appear in logs (they are typed metadata); no other content does', async () => {
  const SENTINEL_PROPOSER = 'SENTINEL_PROPOSER_ID_AAA';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool, log });
  const decision = reviewDecideDecision();
  // We don't pass any free-text content — the locked vocabularies
  // are the only fields the actor logs. Demonstrate that the
  // actor never reaches into params for unexpected fields.
  await actor.execute(decision, baseParams());
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.review_decision.recorded'));
  assert.ok(text.includes('approved'));
  assert.ok(text.includes('approved_admin_review'));
  // The actor never logs the proposer id (it was never in
  // params); confirm a manufactured sentinel passed as an unknown
  // field is silently ignored (no log line contains it).
  await actor.execute(decision, Object.assign(baseParams({
    reviewQueueId: 'cccccccc-1111-1111-1111-cccccccccccc',
  }), { proposerSentinel: SENTINEL_PROPOSER }));
  assert.equal(log.asJoinedText().includes(SENTINEL_PROPOSER), false);
});
