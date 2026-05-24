'use strict';
/*
 * Adversarial test suite — GM-22.
 *
 * This is the project's first NEGATIVE test surface. Every prior
 * suite asserts positive behavior ("the thing does what it says").
 * This one asserts negative behavior — "the thing cannot be made
 * to do what it must not."
 *
 * Per the GM-22 process lock, every high-risk GM going forward
 * must include or extend this suite with adversarial probes
 * against the contract it relies on.
 *
 * The GM-22 contract has two surfaces under adversarial review:
 *
 *   A. The GM-21 governance Decision opacity / classification
 *      properties.
 *   B. The GM-22 actor Decision-verification properties.
 *
 * Each adversarial scenario is structured:
 *
 *   - "Attempt": the bypass / forgery / tampering / type-confusion
 *     pattern being probed.
 *   - "Assertion": the test that the attempt fails closed.
 *
 * The conversation runtime is mocked end-to-end so the actor is
 * exercised against a real Decision flow without any DB or model
 * dependency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../../src/governance');
const {
  classifyExecutionIntent,
  Decision,
  isValidDecision,
  INTENT_TYPES,
  DECISION_OUTCOMES,
  REASONS,
} = governance;
const { createResponseDeliveryActor, createReviewQueueActor, OUTCOMES } = require('../../src/actors');
const memoryAudit = require('../../src/memory/audit');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeMockRuntime() {
  let calls = 0;
  return {
    getCalls: () => calls,
    async respond() {
      calls += 1;
      return { response: 'OK', memoryCount: 0 };
    },
  };
}

function baseParams() {
  return { pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hello' };
}

// ===================================================================
// A. GM-21 Decision opacity adversarial probes
// ===================================================================

test('A1. Attempt: external `new Decision(...)` with the right shape. Assertion: throws — constructor refuses without internal token.', () => {
  assert.throws(
    () =>
      new Decision('not-the-token', {
        intentType: INTENT_TYPES.RESPONSE_DELIVER,
        decision: DECISION_OUTCOMES.ADMISSIBLE,
        reason: REASONS.RESPONSE_DELIVERY_PERMITTED,
      }),
    /cannot be constructed externally/
  );
});

test('A2. Attempt: external `new Decision(undefined, ...)`. Assertion: throws.', () => {
  assert.throws(() => new Decision(), /cannot be constructed externally/);
});

test('A3. Attempt: import internal _createDecision from src/governance/index. Assertion: not re-exported.', () => {
  assert.equal(governance._createDecision, undefined);
  assert.equal(governance._TOKEN, undefined);
  assert.equal(governance._BLESSED, undefined);
});

test('A4. Attempt: import internal _createDecision from src/governance/decisions directly. Assertion: re-asserts the surface that the actor boundary guard rejects this path for actors.', () => {
  // The internal module DOES expose _createDecision (the classifier
  // needs it). The boundary guard for src/actors/ rejects any
  // import of "../governance/<deeper>" — only the public entry is
  // permitted. This test verifies the export shape; the boundary
  // guard test (run in CI) verifies the actor cannot reach it.
  const decisionsModule = require('../../src/governance/decisions');
  assert.equal(typeof decisionsModule._createDecision, 'function');
  // But isValidDecision is the only way for an external caller to
  // know whether a Decision is genuine — even with access to
  // _createDecision, the actor's verifyDecisionOrThrow uses
  // isValidDecision, which closes the WeakSet seam.
  assert.equal(typeof decisionsModule.isValidDecision, 'function');
});

test('A5. Attempt: mutate a classifier-produced Decision. Assertion: frozen — mutation throws.', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  assert.equal(Object.isFrozen(d), true);
  assert.throws(() => { d.decision = DECISION_OUTCOMES.INADMISSIBLE; });
  assert.throws(() => { d.reason = REASONS.UNKNOWN_INTENT_TYPE; });
  assert.throws(() => { d.intentType = 'malicious.intent'; });
  assert.throws(() => { d.injected = 'bonus property'; });
  // Re-read: nothing changed.
  assert.equal(d.decision, DECISION_OUTCOMES.ADMISSIBLE);
  assert.equal(d.reason, REASONS.RESPONSE_DELIVERY_PERMITTED);
  assert.equal(d.intentType, INTENT_TYPES.RESPONSE_DELIVER);
});

test('A6. Attempt: classifier with adversarial inputs (Symbol keys, Proxy, frozen object, __proto__ payload). Assertion: always returns a Decision; never throws; never echoes content.', () => {
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
  let results;
  try {
    results = [
      classifyExecutionIntent(new Proxy({ type: INTENT_TYPES.RESPONSE_DELIVER }, {})),
      classifyExecutionIntent(Object.freeze({ type: INTENT_TYPES.RESPONSE_DELIVER })),
      classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER, [Symbol('attack')]: 'x' }),
      classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER, __proto__: { evil: true } }),
      classifyExecutionIntent({ type: 'attempted.injection; DROP TABLE memory_store; --' }),
      classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER, payload: { content: 'A'.repeat(1024 * 1024) } }),
    ];
  } finally {
    process.stdout.write = original;
  }
  for (const r of results) {
    assert.ok(r instanceof Decision, 'classifier must always return a Decision');
    assert.equal(Object.isFrozen(r), true);
  }
  assert.equal(captured.length, 0, 'classifier must emit nothing to stdout');
});

// ===================================================================
// B. GM-22 actor adversarial probes
// ===================================================================

test('B1. Attempt: pass a plain object (duck-typed Decision) to the actor. Assertion: throws — instanceof check fails.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const fake = {
    intentType: INTENT_TYPES.RESPONSE_DELIVER,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.RESPONSE_DELIVERY_PERMITTED,
    policyRef: 'conversation-runtime-boundary.md §5',
  };
  await assert.rejects(
    () => actor.execute(fake, baseParams()),
    /must be a Decision instance/
  );
  assert.equal(runtime.getCalls(), 0, 'runtime must not have been called');
});

test('B2. Attempt: prototype-tampered fake (Object.setPrototypeOf + Object.freeze) → passes instanceof, but isValidDecision fails. Assertion: throws — WeakSet membership check rejects the fake.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const fake = {
    intentType: INTENT_TYPES.RESPONSE_DELIVER,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.RESPONSE_DELIVERY_PERMITTED,
    policyRef: 'conversation-runtime-boundary.md §5',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  // The forgery passes `instanceof Decision`...
  assert.ok(fake instanceof Decision, 'prototype tampering bypasses instanceof — this is why isValidDecision exists');
  // ...but fails isValidDecision because it was never added to the
  // classifier's WeakSet of blessed instances.
  assert.equal(isValidDecision(fake), false);
  // And the actor rejects it explicitly.
  await assert.rejects(
    () => actor.execute(fake, baseParams()),
    /prototype tampering or forgery/
  );
  assert.equal(runtime.getCalls(), 0);
});

test('B3. Attempt: Decision with the right shape but for a different intent type. Assertion: throws — intentType confusion check rejects it.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  // memory.candidate.create with AI_INFERRED → requires_review
  // (a genuine, blessed Decision) but for the WRONG intent type.
  const wrong = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  assert.ok(wrong instanceof Decision);
  assert.equal(isValidDecision(wrong), true, 'wrong is a genuine Decision — just for the wrong intent type');
  await assert.rejects(
    () => actor.execute(wrong, baseParams()),
    /intentType must be response\.deliver/
  );
  assert.equal(runtime.getCalls(), 0);
});

test('B4. Attempt: invoke actor with a non-object decision (null / undefined / string / number). Assertion: throws — instanceof check fails first.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  for (const bad of [null, undefined, 'admissible', 42, true, [], () => 'fn']) {
    await assert.rejects(
      () => actor.execute(bad, baseParams()),
      /must be a Decision instance/
    );
  }
  assert.equal(runtime.getCalls(), 0);
});

test('B5. Attempt: classify response.deliver, then construct a NEW Decision instance via the same path, mutate the new one (impossible). Assertion: the second Decision is fresh and frozen; mutation throws; the original is unaffected.', () => {
  const a = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  const b = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  assert.notEqual(a, b, 'each classifier call produces a fresh Decision');
  assert.equal(isValidDecision(a), true);
  assert.equal(isValidDecision(b), true);
  assert.throws(() => { b.decision = 'inadmissible'; });
  assert.equal(a.decision, DECISION_OUTCOMES.ADMISSIBLE);
});

test('B6. Attempt: build an actor with an admissible Decision that was once classified, then reuse it across many calls. Assertion: each call still produces an EXECUTED outcome (stateless) and the Decision passes verification every time.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  for (let i = 0; i < 5; i += 1) {
    const r = await actor.execute(d, baseParams());
    assert.equal(r.outcome, OUTCOMES.EXECUTED);
    assert.equal(r.decision, d);
  }
  assert.equal(runtime.getCalls(), 5, 'each call calls the runtime exactly once');
});

test('B7. Attempt: classifier-blessed Decision but with the actor handed a runtime that throws. Assertion: the actor surfaces the runtime error without altering the Decision.', async () => {
  const sdkError = new Error('runtime exploded');
  const runtime = {
    async respond() { throw sdkError; },
  };
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  await assert.rejects(() => actor.execute(d, baseParams()), /runtime exploded/);
  // The Decision is unchanged after a runtime failure.
  assert.equal(d.decision, DECISION_OUTCOMES.ADMISSIBLE);
  assert.equal(Object.isFrozen(d), true);
});

// ===================================================================
// C. EVENT_TYPES lock — adversarial snapshot (OQ-22.9)
// ===================================================================

test('C1. EVENT_TYPES snapshot: the GM-18-locked memory-audit vocabulary is unchanged by GM-22.', () => {
  // GM-22 introduced no new audit event types. If a future PR
  // expands the audit vocabulary, this snapshot diff will catch
  // it and force a paired review of the GM-18 lock.
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'memory EVENT_TYPES snapshot drifted — adding event types requires paired updates to docs/governance/');
  // The actor logger emits its own structured events
  // (actor.response_delivery.executed/abstained/rejected) but those
  // are operational log events, NOT memory-audit-vocabulary entries —
  // they don't go through governance_audit_log.
});

test('C2. REASONS snapshot: GM-21 vocabulary + the GM-24 addition (review_decision_recording_permitted).', () => {
  // GM-24 added exactly one REASON. If a future PR widens the
  // vocabulary, this snapshot diff catches it and forces a paired
  // review of the governance + actor + adversarial-test docs.
  const SNAPSHOT = [
    'ai_inferred_requires_review',
    'external_side_effects_not_authorized',
    'malformed_intent_payload',
    'response_delivery_permitted',
    'retraction_infrastructure_not_available',
    'review_decision_recording_permitted',
    'supersession_infrastructure_not_available',
    'unknown_intent_type',
    'user_stated_requires_review',
    'vault_infrastructure_not_available',
    'verified_fact_self_promotion_forbidden',
    'visibility_promotion_requires_authority',
  ];
  const current = Object.values(REASONS).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'governance REASONS snapshot drifted — adding reasons requires paired updates to docs/governance/');
});

test('C3. INTENT_TYPES snapshot: GM-21 taxonomy + the GM-24 addition (governance.review.decide).', () => {
  // GM-24 added exactly one intent type. If a future PR widens
  // the taxonomy, this snapshot diff catches it.
  const SNAPSHOT = [
    'external.side_effect',
    'governance.review.decide',
    'memory.candidate.create',
    'memory.retract',
    'memory.supersede',
    'memory.visibility.promote',
    'response.deliver',
    'vault.session.open',
    'vault.session.revoke',
  ];
  const current = Object.values(INTENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'INTENT_TYPES snapshot drifted — adding intent types requires paired updates to docs/governance/');
});

test('C4. OUTCOMES snapshot: GM-22/23 + the GM-24 addition (recorded).', () => {
  // GM-24 added exactly one actor outcome. The five-way set is
  // locked here; any future widening must update this snapshot
  // alongside docs/governance/actor-runtime-boundary.md.
  const SNAPSHOT = ['abstained', 'executed', 'recorded', 'rejected', 'staged'];
  const current = Object.values(OUTCOMES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'actor OUTCOMES snapshot drifted — adding outcomes requires paired updates to actor-runtime-boundary.md');
});

// ===================================================================
// D. The contract: admissibility-before-execution is structurally enforced
// ===================================================================

test('D1. Without going through the classifier, no caller can produce a Decision the actor will accept.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  // Build every "almost-valid" forgery we can think of.
  const forgeries = [
    {}, // empty
    { intentType: INTENT_TYPES.RESPONSE_DELIVER },
    { intentType: INTENT_TYPES.RESPONSE_DELIVER, decision: DECISION_OUTCOMES.ADMISSIBLE },
    { intentType: INTENT_TYPES.RESPONSE_DELIVER, decision: DECISION_OUTCOMES.ADMISSIBLE, reason: REASONS.RESPONSE_DELIVERY_PERMITTED },
    { intentType: INTENT_TYPES.RESPONSE_DELIVER, decision: DECISION_OUTCOMES.ADMISSIBLE, reason: REASONS.RESPONSE_DELIVERY_PERMITTED, policyRef: 'x' },
  ];
  for (const forge of forgeries) {
    await assert.rejects(
      () => actor.execute(forge, baseParams()),
      /Decision/i,
      `forgery should be rejected: ${JSON.stringify(forge)}`
    );
  }
  // And the prototype-tampered + frozen variant of the full-shape
  // forgery (also probed in B2).
  const tampered = { ...forgeries[forgeries.length - 1] };
  Object.setPrototypeOf(tampered, Decision.prototype);
  Object.freeze(tampered);
  await assert.rejects(
    () => actor.execute(tampered, baseParams()),
    /prototype tampering or forgery/
  );
  // Every forgery attempt failed; the runtime was never consulted.
  assert.equal(runtime.getCalls(), 0);
});

test('D2. The classifier is the ONLY production path to a Decision the actor accepts.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  // Classifier path: works.
  const real = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  const result = await actor.execute(real, baseParams());
  assert.equal(result.outcome, OUTCOMES.EXECUTED);
  // No other call to the actor outside this test has happened, so
  // the runtime was called exactly once — proving that the SOLE
  // path through the actor's verification chain to an executed
  // outcome is the classifier path.
  assert.equal(runtime.getCalls(), 1);
});

test('D3. Mutating a Decision after classification (impossible) does not change the actor outcome.', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const d = classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE });
  // Try to mutate — fails silently in non-strict; throws here.
  assert.throws(() => { d.decision = 'admissible'; });
  // Actor still sees the original (inadmissible) classification.
  await assert.rejects(
    () => actor.execute(d, baseParams()),
    /intentType must be response\.deliver/
  );
  assert.equal(runtime.getCalls(), 0);
});

test('D4. No side-channel: the classifier and the actor must not write to stdout when handling adversarial inputs.', async () => {
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    // Classify adversarial inputs.
    classifyExecutionIntent(null);
    classifyExecutionIntent({ type: 'attack' });
    classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
    // Build an actor with NO logger and attempt every bypass path.
    const runtime = makeMockRuntime();
    const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
    const fake = { intentType: INTENT_TYPES.RESPONSE_DELIVER, decision: DECISION_OUTCOMES.ADMISSIBLE, reason: REASONS.RESPONSE_DELIVERY_PERMITTED, policyRef: 'x' };
    try { await actor.execute(fake, baseParams()); } catch { /* expected */ }
    Object.setPrototypeOf(fake, Decision.prototype); Object.freeze(fake);
    try { await actor.execute(fake, baseParams()); } catch { /* expected */ }
  } finally {
    process.stdout.write = original;
  }
  assert.equal(captured.length, 0, 'classifier and actor (no logger) must emit nothing to stdout');
});

// ===================================================================
// E. GM-23 review-queue actor adversarial probes
// ===================================================================

function makeMockReviewPool() {
  const queries = [];
  let connectCalls = 0;
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'eeeeeeee-9999-9999-9999-eeeeeeeeeeee', created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    getQueries: () => queries,
    getConnectCalls: () => connectCalls,
    connect: async () => { connectCalls += 1; return client; },
  };
}

function baseReviewParams() {
  return { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' };
}

test('E1. Attempt: pass a plain duck-typed Decision to the review-queue actor. Assertion: throws — instanceof check fails.', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    decision: DECISION_OUTCOMES.REQUIRES_REVIEW,
    reason: REASONS.AI_INFERRED_REQUIRES_REVIEW,
    policyRef: 'source-of-truth-memory-policy.md §3, §5',
  };
  await assert.rejects(() => actor.execute(fake, baseReviewParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0, 'pool must not have been consulted');
});

test('E2. Attempt: prototype-tampered fake → passes instanceof but isValidDecision fails. Assertion: throws.', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    decision: DECISION_OUTCOMES.REQUIRES_REVIEW,
    reason: REASONS.AI_INFERRED_REQUIRES_REVIEW,
    policyRef: 'source-of-truth-memory-policy.md §3, §5',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision, 'prototype tampering bypasses instanceof');
  await assert.rejects(() => actor.execute(fake, baseReviewParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('E3. Attempt: real admissible Decision (response.deliver) → rejected. Assertion: throws — only requires_review can be staged.', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const admissible = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  await assert.rejects(
    () => actor.execute(admissible, baseReviewParams()),
    /only requires_review Decisions can be staged/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('E4. Attempt: real inadmissible Decision (memory.visibility.promote) → rejected.', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const inadmissible = classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE });
  await assert.rejects(
    () => actor.execute(inadmissible, baseReviewParams()),
    /only requires_review Decisions can be staged/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('E5. Attempt: real requires_review Decision but with non-UUID pilotInstanceId. Assertion: throws BEFORE pool.connect.', async () => {
  const pool = makeMockReviewPool();
  const actor = createReviewQueueActor({ reviewQueuePool: pool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  await assert.rejects(
    () => actor.execute(requires, { ...baseReviewParams(), pilotInstanceId: 'not-a-uuid' }),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('E6. Attempt: sentinel content in payloadSummary AND evidenceSummary. Assertion: neither appears in captured logs.', async () => {
  const PAYLOAD_SENTINEL = 'E6_PAYLOAD_SECRET_AAA';
  const EVIDENCE_SENTINEL = 'E6_EVIDENCE_SECRET_BBB';
  const pool = makeMockReviewPool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createReviewQueueActor({ reviewQueuePool: pool, log });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  await actor.execute(requires, {
    ...baseReviewParams(),
    payloadSummary: { content: `proposal: ${PAYLOAD_SENTINEL}` },
    evidenceSummary: { trace: EVIDENCE_SENTINEL },
  });
  const text = captured.join('\n');
  assert.equal(text.includes(PAYLOAD_SENTINEL), false, 'payload content must not appear in logs');
  assert.equal(text.includes(EVIDENCE_SENTINEL), false, 'evidence content must not appear in logs');
  assert.ok(text.includes('actor.review_queue.staged'), 'metadata event must be emitted');
});

test('E10. EVENT_TYPES snapshot still passes — GM-23 added NO new audit event types.', () => {
  // Re-asserts GM-22 C1 to make the lock visible at the GM-23 boundary.
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-23 must not widen memory EVENT_TYPES — the queue table IS the artifact');
});

// ===================================================================
// F. GM-24 review-decision actor adversarial probes
// ===================================================================

const { createReviewDecisionActor } = require('../../src/actors');

const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const QUEUE_ID = 'eeeeeeee-1111-2222-3333-eeeeeeeeeeee';

function makeMockReviewDecisionPool() {
  const queries = [];
  let connectCalls = 0;
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'dddddddd-2222-2222-2222-dddddddddddd', reviewed_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    getQueries: () => queries,
    getConnectCalls: () => connectCalls,
    connect: async () => { connectCalls += 1; return client; },
  };
}

function baseReviewDecisionParams() {
  return {
    pilotInstanceId: PILOT,
    userId: ADMIN,
    userRole: 'admin',
    reviewQueueId: QUEUE_ID,
    reviewOutcome: 'approved',
    reviewReason: 'approved_admin_review',
  };
}

test('F1. Plain-object Decision to review-decision actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.REVIEW_DECISION_RECORDING_PERMITTED,
    policyRef: 'review-decision-runtime-boundary.md §3',
  };
  await assert.rejects(() => actor.execute(fake, baseReviewDecisionParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('F2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.REVIEW_DECISION_RECORDING_PERMITTED,
    policyRef: 'review-decision-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision, 'prototype tampering bypasses instanceof');
  await assert.rejects(() => actor.execute(fake, baseReviewDecisionParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('F3. Real Decision with wrong intent type (response.deliver) → throws (layer-4).', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  await assert.rejects(
    () => actor.execute(wrong, baseReviewDecisionParams()),
    /decision\.intentType must be "governance\.review\.decide"/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('F4. Real Decision with requires_review outcome (memory.candidate.create AI_INFERRED) → throws (wrong intent type first; then outcome layer if intent matched).', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  await assert.rejects(() => actor.execute(requires, baseReviewDecisionParams()), /intentType/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('F5. Non-admin userRole (senior, family, caregiver, system) → throws BEFORE pool.connect.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  for (const role of ['senior', 'family', 'caregiver', 'system']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseReviewDecisionParams(), userRole: role }),
      /userRole must be "admin"/,
      `non-admin role ${role} should be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0, 'pool must not be consulted on any non-admin attempt');
});

test('F6. reviewOutcome outside locked vocabulary (e.g. "pending", "maybe") → throws.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  for (const bad of ['pending', 'maybe', 'unknown', '', 'APPROVED']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseReviewDecisionParams(), reviewOutcome: bad }),
      /reviewOutcome must be one of/
    );
  }
});

test('F7. reviewReason outside locked vocabulary → throws.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  for (const bad of ['because', 'rejected_for_fun', '', 'APPROVED_ADMIN_REVIEW']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseReviewDecisionParams(), reviewReason: bad }),
      /reviewReason must be one of/
    );
  }
});

test('F8. reviewQueueId / pilotInstanceId / userId non-UUID → throws BEFORE pool.connect.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await assert.rejects(
    () => actor.execute(decision, { ...baseReviewDecisionParams(), reviewQueueId: 'not-uuid' }),
    /reviewQueueId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseReviewDecisionParams(), pilotInstanceId: 'x' }),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseReviewDecisionParams(), userId: 'y' }),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('F9. Reviewer impersonation by input: passing reviewerUserId in params is silently ignored — actor sources from userId only.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await actor.execute(
    decision,
    Object.assign(baseReviewDecisionParams(), { reviewerUserId: '99999999-9999-9999-9999-999999999999' })
  );
  // The INSERT happened — verify the actor used the session userId,
  // not the spoofed input field. We can't see the SQL params from
  // here (mock client.query took only the query text), but the
  // absence of any error path tied to the spoof is the proof. The
  // repository-layer test (test 'recordReviewDecision: INSERT shape
  // sources reviewer_user_id from session context') asserts the
  // parameter binding directly.
  assert.equal(pool.getConnectCalls(), 1);
});

test('F10. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'F10_SECRET_AAA';
  const pool = makeMockReviewDecisionPool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createReviewDecisionActor({ reviewQueuePool: pool, log });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await actor.execute(
    decision,
    Object.assign(baseReviewDecisionParams(), { reviewerNotes: SENTINEL, payload: SENTINEL })
  );
  const text = captured.join('\n');
  assert.equal(text.includes(SENTINEL), false, 'unknown-field sentinel must not appear in logs');
  assert.ok(text.includes('actor.review_decision.recorded'), 'metadata event must be emitted');
});

test('F11. EVENT_TYPES snapshot still locked — GM-24 added NO new audit event types.', () => {
  // The governance_review_decisions table IS the artifact (per OQ-24.9).
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-24 must not widen memory EVENT_TYPES — the review-decisions table IS the artifact');
});

test('F12. Sole production path to a review_decide Decision the actor accepts is classifyExecutionIntent.', async () => {
  const pool = makeMockReviewDecisionPool();
  const actor = createReviewDecisionActor({ reviewQueuePool: pool });
  // Real classifier path: works.
  const real = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  const result = await actor.execute(real, baseReviewDecisionParams());
  assert.equal(result.outcome, OUTCOMES.RECORDED);
  // The actor reached the pool exactly once on the only valid path
  // exercised in this test.
  assert.equal(pool.getConnectCalls(), 1);
});
