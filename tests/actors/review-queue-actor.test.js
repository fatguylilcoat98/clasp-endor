'use strict';
/*
 * Unit tests for the GM-23 review-queue actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised). The review queue pool is mocked — no DB.
 *
 * Negative properties (forged Decisions, prototype tampering,
 * outcome-routing bypass attempts) live in the dedicated
 * adversarial suite at tests/governance/adversarial.test.js
 * (E-series, GM-23 additions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createReviewQueueActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeMockReviewPool() {
  // The pool's `connect` returns a client whose query handles the
  // BEGIN / set_config / INSERT / COMMIT chain that
  // withReviewContext + stageReviewItem produce.
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'eeeeeeee-3333-3333-3333-eeeeeeeeeeee', created_at: new Date() }], rowCount: 1 };
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

function requiresReviewDecision() {
  return classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
}

function admissibleDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
}

function inadmissibleDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: USER,
      userRole: 'senior',
      payloadSummary: { content: 'proposed memory text', provenance: 'AI_INFERRED' },
      evidenceSummary: { source: 'model_output' },
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createReviewQueueActor: rejects missing options', () => {
  assert.throws(() => createReviewQueueActor(), /options object is required/);
  assert.throws(() => createReviewQueueActor(null), /options object is required/);
});

test('createReviewQueueActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createReviewQueueActor({}), /reviewQueuePool is required/);
});

test('actor: returned object is frozen and exposes ONLY execute', () => {
  const actor = createReviewQueueActor({ reviewQueuePool: makeMockReviewPool() });
  assert.equal(typeof actor.execute, 'function');
  for (const forbidden of ['reviewQueuePool', 'pool', 'handle', 'connect', 'query', 'client', 'log']) {
    assert.equal(actor[forbidden], undefined, `actor must not expose .${forbidden}`);
  }
  assert.equal(Object.isFrozen(actor), true);
  assert.throws(() => { actor.foo = 1; });
});

// ---- happy path ----

test('actor.execute: real requires_review Decision → stages exactly one queue row; outcome staged', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const decision = requiresReviewDecision();
  const result = await actor.execute(decision, baseParams());

  assert.equal(result.outcome, OUTCOMES.STAGED);
  assert.equal(result.decision, decision);
  assert.match(result.queueEntryId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt);
  assert.equal(Object.isFrozen(result), true);

  // Confirms BEGIN + 3× set_config + INSERT + COMMIT.
  const texts = pool.getQueries();
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts.slice(1, 4).every((t) => t === 'SELECT set_config($1, $2, true)'), true);
  assert.match(texts[4], /INSERT INTO governance_review_queue/);
  assert.equal(texts[5], 'COMMIT');
});

// ---- the SIXTH verification layer: outcome must be requires_review ----

test('actor.execute: admissible Decision → THROWS (only requires_review can be staged)', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  await assert.rejects(
    () => actor.execute(admissibleDecision(), baseParams()),
    /only requires_review Decisions can be staged/
  );
  assert.equal(pool.getConnectCalls(), 0, 'pool must not have been consulted');
});

test('actor.execute: inadmissible Decision → THROWS (only requires_review can be staged)', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  await assert.rejects(
    () => actor.execute(inadmissibleDecision(), baseParams()),
    /only requires_review Decisions can be staged/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- params validation ----

test('actor.execute: rejects missing params object', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  await assert.rejects(
    () => actor.execute(requiresReviewDecision(), null),
    /params object is required/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('actor.execute: rejects non-UUID pilot/user', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  await assert.rejects(
    () => actor.execute(requiresReviewDecision(), baseParams({ pilotInstanceId: 'nope' })),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(requiresReviewDecision(), baseParams({ userId: 'nope' })),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('actor.execute: rejects bad userRole', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  await assert.rejects(
    () => actor.execute(requiresReviewDecision(), baseParams({ userRole: 'overlord' })),
    /userRole must be one of/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- log hygiene ----

test('actor.execute: sentinel content in payloadSummary AND evidenceSummary NEVER appears in captured logs', async () => {
  const PAYLOAD_SENTINEL = 'REVIEW_PAYLOAD_SECRET_999';
  const EVIDENCE_SENTINEL = 'REVIEW_EVIDENCE_SECRET_888';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createReviewQueueActor({ reviewQueuePool: pool, log });

  await actor.execute(requiresReviewDecision(), baseParams({
    payloadSummary: { content: `proposed: ${PAYLOAD_SENTINEL}` },
    evidenceSummary: { trace: EVIDENCE_SENTINEL },
  }));

  const captured = log.asJoinedText();
  assert.equal(captured.includes(PAYLOAD_SENTINEL), false);
  assert.equal(captured.includes(EVIDENCE_SENTINEL), false);
  // Sanity: the metadata event was emitted.
  assert.ok(captured.includes('actor.review_queue.staged'));
});

test('actor.execute: works without optional logger', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const result = await actor.execute(requiresReviewDecision(), baseParams());
  assert.equal(result.outcome, OUTCOMES.STAGED);
});

// ---- shared OUTCOMES + index re-exports ----

test('OUTCOMES includes the new STAGED value alongside the existing three', () => {
  assert.equal(OUTCOMES.STAGED, 'staged');
  assert.equal(OUTCOMES.EXECUTED, 'executed');
  assert.equal(OUTCOMES.ABSTAINED, 'abstained');
  assert.equal(OUTCOMES.REJECTED, 'rejected');
  assert.equal(Object.isFrozen(OUTCOMES), true);
});

test('src/actors/index: re-exports createReviewQueueActor alongside the response-delivery actor', () => {
  const actors = require('../../src/actors');
  assert.equal(typeof actors.createReviewQueueActor, 'function');
  assert.equal(typeof actors.createResponseDeliveryActor, 'function');
  assert.equal(typeof actors.OUTCOMES, 'object');
  // Internal helpers must NOT be re-exported.
  assert.equal(actors.verifyDecisionOrThrow, undefined);
  assert.equal(actors.validateParams, undefined);
});
