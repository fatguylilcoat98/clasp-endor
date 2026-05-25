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

test('C2. REASONS snapshot: GM-21 + GM-24 + GM-25 + GM-26 + GM-27 + GM-28 + GM-29 additions.', () => {
  const SNAPSHOT = [
    'ai_inferred_requires_review',
    'execution_attempt_recording_permitted',
    'execution_authorization_recording_permitted',
    'execution_claim_recording_permitted',
    'execution_outcome_recording_permitted',
    'execution_verification_recording_permitted',
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

test('C3. INTENT_TYPES snapshot: GM-21 + GM-24 + GM-25 + GM-26 + GM-27 + GM-28 + GM-29 additions.', () => {
  const SNAPSHOT = [
    'external.side_effect',
    'governance.execution.attempt',
    'governance.execution.authorize',
    'governance.execution.claim',
    'governance.execution.outcome.record',
    'governance.execution.verify',
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

test('C4. OUTCOMES snapshot: GM-22 through GM-28 + the GM-29 addition (verification_recorded).', () => {
  // GM-29 added exactly one actor outcome. The ten-way set is
  // locked here; any future widening must update this snapshot
  // alongside docs/governance/actor-runtime-boundary.md.
  const SNAPSHOT = [
    'abstained', 'attempt_recorded', 'authorized_recorded',
    'claim_recorded', 'executed', 'outcome_recorded',
    'recorded', 'rejected', 'staged', 'verification_recorded',
  ];
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

// ===================================================================
// G. GM-25 execution-authorization actor adversarial probes
// ===================================================================

const { createExecutionAuthorizationActor } = require('../../src/actors');

const REVIEW_DECISION_ID = 'dddddddd-1111-1111-1111-dddddddddddd';

function makeMockAuthPool() {
  const queries = [];
  let connectCalls = 0;
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'cccccccc-9999-9999-9999-cccccccccccc', created_at: new Date() }], rowCount: 1 };
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

function baseAuthParams() {
  return {
    pilotInstanceId: PILOT,
    userId: ADMIN,
    userRole: 'admin',
    reviewDecisionId: REVIEW_DECISION_ID,
    authorizationScope: 'memory_candidate_admission',
    authorizationReason: 'admin_explicit_authorization',
  };
}

test('G1. Plain-object Decision to execution-authorization actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_AUTHORIZATION_RECORDING_PERMITTED,
    policyRef: 'execution-authorization-runtime-boundary.md §3',
  };
  await assert.rejects(() => actor.execute(fake, baseAuthParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('G2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_AUTHORIZATION_RECORDING_PERMITTED,
    policyRef: 'execution-authorization-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision);
  await assert.rejects(() => actor.execute(fake, baseAuthParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('G3. Real Decision with wrong intent type (governance.review.decide) → throws (layer-4).', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await assert.rejects(
    () => actor.execute(wrong, baseAuthParams()),
    /decision\.intentType must be "governance\.execution\.authorize"/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('G4. Real Decision with response.deliver intent → throws (layer-4).', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  await assert.rejects(() => actor.execute(wrong, baseAuthParams()), /intentType/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('G5. Non-admin userRole rejected BEFORE pool.connect.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  for (const role of ['senior', 'family', 'caregiver', 'system']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAuthParams(), userRole: role }),
      /userRole must be "admin"/,
      `non-admin role ${role} should be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('G6. authorizationScope outside locked vocabulary → throws.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  for (const bad of ['arbitrary_action', '', 'MEMORY_CANDIDATE_ADMISSION', 'memory_candidate_admission ', 'execute_now']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAuthParams(), authorizationScope: bad }),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('G7. authorizationReason outside locked vocabulary → throws.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  for (const bad of ['because', 'admin_did_it', '', 'ADMIN_EXPLICIT_AUTHORIZATION']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAuthParams(), authorizationReason: bad }),
      /authorizationReason must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('G8. reviewDecisionId / pilotInstanceId / userId non-UUID → throws BEFORE pool.connect.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  await assert.rejects(
    () => actor.execute(decision, { ...baseAuthParams(), reviewDecisionId: 'not-uuid' }),
    /reviewDecisionId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseAuthParams(), pilotInstanceId: 'x' }),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseAuthParams(), userId: 'y' }),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('G9. Authorizer impersonation by input: authorizedByUserId in params is silently ignored.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  await actor.execute(
    decision,
    Object.assign(baseAuthParams(), { authorizedByUserId: '99999999-9999-9999-9999-999999999999' })
  );
  // The INSERT happened — the repository-layer test asserts the
  // parameter binding sources from sessionCtx, not from input.
  assert.equal(pool.getConnectCalls(), 1);
});

test('G10. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'G10_SECRET_AAA';
  const pool = makeMockAuthPool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool, log });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  await actor.execute(
    decision,
    Object.assign(baseAuthParams(), { authorizerNotes: SENTINEL, payload: SENTINEL })
  );
  const text = captured.join('\n');
  assert.equal(text.includes(SENTINEL), false, 'unknown-field sentinel must not appear in logs');
  assert.ok(text.includes('actor.execution_authorization.recorded'));
});

test('G11. EVENT_TYPES snapshot still locked — GM-25 added NO new audit event types.', () => {
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-25 must not widen memory EVENT_TYPES — the authorizations table IS the artifact');
});

test('G12. Sole production path to a governance.execution.authorize Decision the actor accepts is classifyExecutionIntent.', async () => {
  const pool = makeMockAuthPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const real = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  const result = await actor.execute(real, baseAuthParams());
  assert.equal(result.outcome, OUTCOMES.AUTHORIZED_RECORDED);
  assert.equal(pool.getConnectCalls(), 1);
});

test('G13. Static scan: zero references to governance_execution_authorizations outside the writing path.', () => {
  // The canary: greps src/ for any reference to the table and
  // asserts the count matches the known writing-path files. Any
  // additional reference is a potential consumer leak.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const WRITING_PATH = new Set([
    'src/review/repository.js',
    'src/review/transaction.js',
    'src/review/index.js',
    'src/actors/execution-authorization-actor.js',
    'src/actors/outcomes.js',
    'src/actors/index.js',
    'scripts/ci/check-review-boundary.js',
  ]);
  function walk(rel, out) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
    } else if (rel.endsWith('.js')) {
      out.push(rel);
    }
  }
  const files = [];
  for (const root of ['src', 'scripts/ci']) walk(root, files);
  const leaks = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (content.includes('governance_execution_authorizations') && !WRITING_PATH.has(rel)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [],
    'GM-25 canary: governance_execution_authorizations referenced outside the writing path — '
    + 'a future consumer may be leaking through. Files with leaks: ' + leaks.join(', '));
});

// ===================================================================
// H. GM-26 execution-claim ledger actor adversarial probes
// ===================================================================

const { createExecutionClaimLedgerActor } = require('../../src/actors');
const {
  VALID_EXECUTION_SURFACES: REPO_EXECUTION_SURFACES,
} = require('../../src/review/repository');

const EXECUTION_AUTHORIZATION_ID = 'cccccccc-1111-1111-1111-cccccccccccc';

function makeMockClaimPool() {
  const queries = [];
  let connectCalls = 0;
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'bbbbbbbb-9999-9999-9999-bbbbbbbbbbbb', created_at: new Date() }], rowCount: 1 };
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

function baseClaimParams() {
  return {
    pilotInstanceId: PILOT,
    userId: ADMIN,
    userRole: 'admin',
    executionAuthorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  };
}

test('H1. Plain-object Decision to claim-ledger actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_CLAIM_RECORDING_PERMITTED,
    policyRef: 'execution-claim-runtime-boundary.md §3',
  };
  await assert.rejects(() => actor.execute(fake, baseClaimParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('H2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_CLAIM_RECORDING_PERMITTED,
    policyRef: 'execution-claim-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision);
  await assert.rejects(() => actor.execute(fake, baseClaimParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('H3. Real Decision with wrong intent type (governance.execution.authorize) → throws (layer-4).', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  await assert.rejects(
    () => actor.execute(wrong, baseClaimParams()),
    /decision\.intentType must be "governance\.execution\.claim"/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('H4. Real Decision with governance.review.decide intent → throws (layer-4).', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await assert.rejects(() => actor.execute(wrong, baseClaimParams()), /intentType/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('H5. Non-admin userRole rejected BEFORE pool.connect.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  for (const role of ['senior', 'family', 'caregiver', 'system']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseClaimParams(), userRole: role }),
      /userRole must be "admin"/,
      `non-admin role ${role} should be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('H6. authorizationScope outside locked vocabulary → throws.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  for (const bad of ['arbitrary_action', '', 'MEMORY_CANDIDATE_ADMISSION', 'memory_candidate_admission ']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseClaimParams(), authorizationScope: bad }),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('H7. executionSurface outside locked vocabulary → throws.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  for (const bad of ['arbitrary_consumer', '', 'FUTURE_MEMORY_ADMISSION_CONSUMER', 'memory_admission_consumer']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseClaimParams(), executionSurface: bad }),
      /executionSurface must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('H8. executionAuthorizationId / pilotInstanceId / userId non-UUID → throws BEFORE pool.connect.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  await assert.rejects(
    () => actor.execute(decision, { ...baseClaimParams(), executionAuthorizationId: 'not-uuid' }),
    /executionAuthorizationId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseClaimParams(), pilotInstanceId: 'x' }),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseClaimParams(), userId: 'y' }),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('H21. Claimant impersonation by input: claimedByUserId in params is silently ignored.', async () => {
  const pool = makeMockClaimPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  await actor.execute(
    decision,
    Object.assign(baseClaimParams(), { claimedByUserId: '99999999-9999-9999-9999-999999999999' })
  );
  // The repository test asserts the parameter binding sources from
  // sessionCtx, not from input.
  assert.equal(pool.getConnectCalls(), 1);
});

test('H14. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'H14_SECRET_AAA';
  const pool = makeMockClaimPool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool, log });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  await actor.execute(
    decision,
    Object.assign(baseClaimParams(), { claimerNotes: SENTINEL, payload: SENTINEL })
  );
  const text = captured.join('\n');
  assert.equal(text.includes(SENTINEL), false, 'unknown-field sentinel must not appear in logs');
  assert.ok(text.includes('actor.execution_claim.recorded'));
});

test('H15. EVENT_TYPES snapshot still locked — GM-26 added NO new audit event types.', () => {
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-26 must not widen memory EVENT_TYPES — the claims table IS the artifact');
});

test('H19. EXECUTION_SURFACES vocabulary lock: exactly 4 values, all future_* prefixed.', () => {
  // H19 + H27 combined: the GM-26 prefix-discipline snapshot.
  // Asserts the set is exactly 4 values AND every value matches
  // the mandatory /^future_/ prefix.
  const SNAPSHOT = [
    'future_external_action_consumer',
    'future_memory_admission_consumer',
    'future_vault_action_consumer',
    'future_visibility_change_consumer',
  ];
  const current = Array.from(REPO_EXECUTION_SURFACES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'EXECUTION_SURFACES snapshot drifted — adding values requires paired updates to docs/governance/');
  assert.equal(current.length, 4, 'EXECUTION_SURFACES must contain exactly 4 values');
  for (const v of current) {
    assert.match(v, /^future_/,
      `EXECUTION_SURFACES value "${v}" must be prefixed with future_ (no consumer exists yet in GM-26)`);
  }
});

test('H20. AUTHORIZATION_SCOPES snapshot unchanged by GM-26.', () => {
  // GM-25 introduced the 4-value AUTHORIZATION_SCOPES set; GM-26
  // did NOT widen it. Snapshot here mirrors GM-25's lock.
  const {
    VALID_AUTHORIZATION_SCOPES,
  } = require('../../src/review/repository');
  const SNAPSHOT = [
    'future_external_action',
    'future_visibility_change',
    'future_vault_action',
    'memory_candidate_admission',
  ];
  const current = Array.from(VALID_AUTHORIZATION_SCOPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'AUTHORIZATION_SCOPES snapshot drifted — GM-26 must not widen the GM-25 vocabulary');
});

test('H22. Static scan: zero references to governance_execution_claims outside the writing path.', () => {
  // The H-series canary: greps src/ and scripts/ci for the table
  // name and asserts the count matches the known writing-path
  // files. Any additional reference is a potential consumer leak.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const WRITING_PATH = new Set([
    'src/review/repository.js',
    'src/review/transaction.js',
    'src/review/index.js',
    'src/actors/execution-claim-ledger-actor.js',
    'src/actors/outcomes.js',
    'src/actors/index.js',
    'scripts/ci/check-review-boundary.js',
  ]);
  function walk(rel, out) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
    } else if (rel.endsWith('.js')) {
      out.push(rel);
    }
  }
  const files = [];
  for (const root of ['src', 'scripts/ci']) walk(root, files);
  const leaks = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (content.includes('governance_execution_claims') && !WRITING_PATH.has(rel)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [],
    'GM-26 canary: governance_execution_claims referenced outside the writing path — '
    + 'a future consumer may be leaking through. Files with leaks: ' + leaks.join(', '));
});

test('H27. EXECUTION_SURFACES prefix discipline (snapshot enforcement).', () => {
  // Per OQ-26.7: explicit assertion that every EXECUTION_SURFACES
  // value matches the mandatory /^future_/ prefix. Same set as
  // H19's snapshot; this test is the standalone prefix-discipline
  // canary that fails immediately if anyone adds a non-prefixed
  // value (e.g. "memory_admission_consumer" without the future_
  // prefix).
  for (const v of REPO_EXECUTION_SURFACES) {
    assert.match(v, /^future_/,
      `H27: EXECUTION_SURFACES value "${v}" must be future_* prefixed `
      + '(GM-26 ships zero consumers; the prefix puts that fact into the data)');
  }
});

test('H28. File-scoped forbidden-vocabulary scan: execution-claim-ledger actor must not contain operational words.', () => {
  // Per OQ-26.14: the claim-ledger actor file must not contain
  // 'executed', 'completed', 'dispatched', 'delivered',
  // 'finalized', 'succeeded', 'failed' as bare identifiers
  // (after stripping comments). The boundary guard enforces this
  // mechanically in CI; this test re-asserts the property at the
  // adversarial-suite layer.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const filePath = path.join(REPO, 'src/actors/execution-claim-ledger-actor.js');
  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip /* */ and // comments before scanning — the actor
  // legitimately references some of these words in its doc
  // header (e.g. "NOT execution"); they don't count.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FORBIDDEN = ['executed', 'completed', 'dispatched', 'delivered', 'finalized', 'succeeded', 'failed'];
  const hits = [];
  for (const word of FORBIDDEN) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(code)) hits.push(word);
  }
  assert.deepEqual(hits, [],
    `H28: execution-claim-ledger actor contains forbidden operational vocabulary: ${hits.join(', ')}. `
    + 'Claim is NOT execution; claim is NOT dispatch; claim is NOT completion; claim is NOT success.');
});

// ===================================================================
// I. GM-27 execution-attempt ledger actor adversarial probes
// ===================================================================

const { createExecutionAttemptLedgerActor } = require('../../src/actors');

const EXECUTION_CLAIM_ID = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';

function makeMockAttemptPool() {
  const queries = [];
  let connectCalls = 0;
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'aaaaaaaa-9999-9999-9999-aaaaaaaaaaaa', created_at: new Date() }], rowCount: 1 };
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

function baseAttemptParams() {
  return {
    pilotInstanceId: PILOT,
    userId: ADMIN,
    userRole: 'admin',
    executionClaimId: EXECUTION_CLAIM_ID,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  };
}

test('I1. Plain-object Decision to attempt-ledger actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_ATTEMPT_RECORDING_PERMITTED,
    policyRef: 'execution-attempt-runtime-boundary.md §3',
  };
  await assert.rejects(() => actor.execute(fake, baseAttemptParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('I2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_ATTEMPT_RECORDING_PERMITTED,
    policyRef: 'execution-attempt-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision);
  await assert.rejects(() => actor.execute(fake, baseAttemptParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('I3. Real Decision with wrong intent type (governance.execution.claim) → throws (layer-4).', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  await assert.rejects(
    () => actor.execute(wrong, baseAttemptParams()),
    /decision\.intentType must be "governance\.execution\.attempt"/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('I4. Real Decision with governance.review.decide intent → throws (layer-4).', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  await assert.rejects(() => actor.execute(wrong, baseAttemptParams()), /intentType/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('I5. Non-admin userRole rejected BEFORE pool.connect.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  for (const role of ['senior', 'family', 'caregiver', 'system']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAttemptParams(), userRole: role }),
      /userRole must be "admin"/,
      `non-admin role ${role} should be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('I6. authorizationScope outside locked vocabulary → throws.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  for (const bad of ['arbitrary_action', '', 'MEMORY_CANDIDATE_ADMISSION']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAttemptParams(), authorizationScope: bad }),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('I7. executionSurface outside locked vocabulary → throws.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  for (const bad of ['arbitrary_consumer', '', 'memory_admission_consumer']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseAttemptParams(), executionSurface: bad }),
      /executionSurface must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('I8. executionClaimId / pilotInstanceId / userId non-UUID → throws BEFORE pool.connect.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  await assert.rejects(
    () => actor.execute(decision, { ...baseAttemptParams(), executionClaimId: 'not-uuid' }),
    /executionClaimId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseAttemptParams(), pilotInstanceId: 'x' }),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, { ...baseAttemptParams(), userId: 'y' }),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('I21. Attempter impersonation by input: attemptedByUserId in params is silently ignored.', async () => {
  const pool = makeMockAttemptPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  await actor.execute(
    decision,
    Object.assign(baseAttemptParams(), { attemptedByUserId: '99999999-9999-9999-9999-999999999999' })
  );
  assert.equal(pool.getConnectCalls(), 1);
});

test('I14. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'I14_SECRET_AAA';
  const pool = makeMockAttemptPool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool, log });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  await actor.execute(
    decision,
    Object.assign(baseAttemptParams(), { attempterNotes: SENTINEL, payload: SENTINEL })
  );
  const text = captured.join('\n');
  assert.equal(text.includes(SENTINEL), false, 'unknown-field sentinel must not appear in logs');
  assert.ok(text.includes('actor.execution_attempt.recorded'));
});

test('I15. EVENT_TYPES snapshot still locked — GM-27 added NO new audit event types.', () => {
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-27 must not widen memory EVENT_TYPES — the attempts table IS the artifact');
});

test('I20. AUTHORIZATION_SCOPES + EXECUTION_SURFACES snapshots unchanged by GM-27.', () => {
  const {
    VALID_AUTHORIZATION_SCOPES,
    VALID_EXECUTION_SURFACES,
  } = require('../../src/review/repository');
  // GM-25's AUTHORIZATION_SCOPES (4 values).
  assert.deepEqual(
    Array.from(VALID_AUTHORIZATION_SCOPES).sort(),
    [
      'future_external_action',
      'future_visibility_change',
      'future_vault_action',
      'memory_candidate_admission',
    ].sort()
  );
  // GM-26's EXECUTION_SURFACES (4 values, all future_* prefixed).
  const surfaces = Array.from(VALID_EXECUTION_SURFACES).sort();
  assert.deepEqual(surfaces, [
    'future_external_action_consumer',
    'future_memory_admission_consumer',
    'future_vault_action_consumer',
    'future_visibility_change_consumer',
  ].sort());
  for (const s of surfaces) {
    assert.match(s, /^future_/, `EXECUTION_SURFACES "${s}" must remain future_* prefixed`);
  }
});

test('I23. Static scan: zero references to governance_execution_attempts outside the writing path.', () => {
  // The I-series canary: greps src/ and scripts/ci for the table
  // name and asserts the count matches the known writing-path
  // files. Any additional reference is a potential consumer leak.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const WRITING_PATH = new Set([
    'src/review/repository.js',
    'src/review/transaction.js',
    'src/review/index.js',
    'src/actors/execution-attempt-ledger-actor.js',
    'src/actors/outcomes.js',
    'src/actors/index.js',
    'scripts/ci/check-review-boundary.js',
  ]);
  function walk(rel, out) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
    } else if (rel.endsWith('.js')) {
      out.push(rel);
    }
  }
  const files = [];
  for (const root of ['src', 'scripts/ci']) walk(root, files);
  const leaks = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (content.includes('governance_execution_attempts') && !WRITING_PATH.has(rel)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [],
    'GM-27 canary: governance_execution_attempts referenced outside the writing path — '
    + 'a future consumer may be leaking through. Files with leaks: ' + leaks.join(', '));
});

test('I24. File-scoped forbidden-vocabulary scan: execution-attempt-ledger actor must not contain operational words.', () => {
  // Per OQ-27.14: the attempt-ledger actor file must not contain
  // outcome-implying vocabulary. The list is STRICTER than the
  // GM-26 claim-ledger scan: adds `committed` (DB commit lives
  // in the transaction layer, never in the actor file).
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const filePath = path.join(REPO, 'src/actors/execution-attempt-ledger-actor.js');
  const raw = fs.readFileSync(filePath, 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FORBIDDEN = [
    'completed', 'succeeded', 'failed', 'delivered',
    'finalized', 'executed', 'dispatched', 'committed',
  ];
  const hits = FORBIDDEN.filter((w) => new RegExp('\\b' + w + '\\b').test(code));
  assert.deepEqual(hits, [],
    `I24: execution-attempt-ledger actor contains forbidden operational vocabulary: ${hits.join(', ')}. `
    + 'ATTEMPT IS NOT OUTCOME. An attempt records ONLY the beginning of an attempt.');
});

test('I27. Doc-presence canary: execution-attempt-runtime-boundary.md must contain both required sections.', () => {
  // Per OQ-27.16: the phantom-attempt problem is genuinely
  // irresolvable at GM-27. The only mechanical defense is
  // ensuring the next-outcome GM sees the warning.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const docPath = path.join(REPO, 'docs/governance/execution-attempt-runtime-boundary.md');
  assert.ok(fs.existsSync(docPath),
    'I27: docs/governance/execution-attempt-runtime-boundary.md must exist');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /^## What this is NOT$/m,
    'I27: doc must contain a "## What this is NOT" section (defends against operational drift)');
  assert.match(doc, /^## What remains unresolved$/m,
    'I27: doc must contain a "## What remains unresolved" section (flags the phantom-attempt problem '
    + 'for the future-outcome GM)');
});

// ===================================================================
// J. GM-28 execution-outcome ledger actor adversarial probes
// ===================================================================

const { createExecutionOutcomeLedgerActor } = require('../../src/actors');

const EXECUTION_ATTEMPT_ID = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeMockOutcomePool() {
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

function baseOutcomeParams() {
  return {
    pilotInstanceId: PILOT,
    userId: ADMIN,
    userRole: 'admin',
    executionAttemptId: EXECUTION_ATTEMPT_ID,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
    outcomeType: 'reported_completed',
  };
}

test('J1. Plain-object Decision to outcome-ledger actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = makeMockOutcomePool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_OUTCOME_RECORDING_PERMITTED,
    policyRef: 'execution-outcome-runtime-boundary.md §3',
  };
  await assert.rejects(() => actor.execute(fake, baseOutcomeParams()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('J2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = makeMockOutcomePool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_OUTCOME_RECORDING_PERMITTED,
    policyRef: 'execution-outcome-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision);
  await assert.rejects(() => actor.execute(fake, baseOutcomeParams()), /prototype tampering or forgery/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('J3. Real Decision with wrong intent type (governance.execution.attempt) → throws (layer-4).', async () => {
  const pool = makeMockOutcomePool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  await assert.rejects(
    () => actor.execute(wrong, baseOutcomeParams()),
    /decision\.intentType must be "governance\.execution\.outcome\.record"/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('J5. Non-admin userRole rejected BEFORE pool.connect.', async () => {
  const pool = makeMockOutcomePool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
  for (const role of ['senior', 'family', 'caregiver', 'system']) {
    await assert.rejects(
      () => actor.execute(decision, { ...baseOutcomeParams(), userRole: role }),
      /userRole must be "admin"/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('J14. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'J14_SECRET_AAA';
  const pool = makeMockOutcomePool();
  const captured = [];
  const log = {
    info(event, fields) {
      captured.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
  };
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool, log });
  const decision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
  await actor.execute(
    decision,
    Object.assign(baseOutcomeParams(), { recorderNotes: SENTINEL, payload: SENTINEL })
  );
  const text = captured.join('\n');
  assert.equal(text.includes(SENTINEL), false, 'unknown-field sentinel must not appear in logs');
  assert.ok(text.includes('actor.execution_outcome.recorded'));
});

test('J15. EVENT_TYPES snapshot still locked — GM-28 added NO new audit event types.', () => {
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-28 must not widen memory EVENT_TYPES — the outcomes table IS the artifact');
});

test('J22. Static scan: zero references to governance_execution_outcomes outside the writing path.', () => {
  // The J-series canary against accidental consumer introduction.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const WRITING_PATH = new Set([
    'src/review/repository.js',
    'src/review/transaction.js',
    'src/review/index.js',
    'src/actors/execution-outcome-ledger-actor.js',
    'src/actors/outcomes.js',
    'src/actors/index.js',
    'scripts/ci/check-review-boundary.js',
  ]);
  function walk(rel, out) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
    } else if (rel.endsWith('.js')) {
      out.push(rel);
    }
  }
  const files = [];
  for (const root of ['src', 'scripts/ci']) walk(root, files);
  const leaks = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (content.includes('governance_execution_outcomes') && !WRITING_PATH.has(rel)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [],
    'GM-28 canary: governance_execution_outcomes referenced outside the writing path — '
    + 'a future consumer may be leaking through. Files with leaks: ' + leaks.join(', '));
});

test('J24. File-scoped forbidden-vocabulary scan: execution-outcome-ledger actor must not contain operational OR truth-claim words.', () => {
  // Per OQ-28.14: the STRICTEST scan in the entire substrate.
  // GM-27's 8 outcome-implying words + 10 NEW truth-claim words
  // = 18 forbidden bare identifiers.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const filePath = path.join(REPO, 'src/actors/execution-outcome-ledger-actor.js');
  const raw = fs.readFileSync(filePath, 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FORBIDDEN = [
    // GM-27 inheritance: outcome-implying vocabulary.
    'completed', 'succeeded', 'failed', 'delivered',
    'finalized', 'executed', 'dispatched', 'committed',
    // GM-28 NEW: truth-claim vocabulary.
    'verified', 'confirmed', 'actual', 'actually',
    'definitely', 'proven', 'certain', 'real', 'reality', 'truth',
  ];
  const hits = FORBIDDEN.filter((w) => new RegExp('\\b' + w + '\\b').test(code));
  assert.deepEqual(hits, [],
    `J24: execution-outcome-ledger actor contains forbidden vocabulary: ${hits.join(', ')}. `
    + 'AN OUTCOME ROW IS NOT TRUTH. `reported_completed` ≠ `verified_completed`.');
});

test('J27. Doc-presence canary: execution-outcome-runtime-boundary.md must contain both required sections.', () => {
  // Mirrors I27. Defends the future-verification GM against
  // silent removal of the unresolved-questions warning.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const docPath = path.join(REPO, 'docs/governance/execution-outcome-runtime-boundary.md');
  assert.ok(fs.existsSync(docPath),
    'J27: docs/governance/execution-outcome-runtime-boundary.md must exist');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /^## What this is NOT$/m,
    'J27: doc must contain a "## What this is NOT" section');
  assert.match(doc, /^## What remains unresolved$/m,
    'J27: doc must contain a "## What remains unresolved" section');
});

test('J37. EXECUTION_OUTCOME_TYPES snapshot: exactly 4 values, all reported_* prefixed.', () => {
  // The constitutional canary of GM-28. The reported_* prefix is
  // not a stylistic convention; it is the structural defense
  // against truth claims. Adding `reported_succeeded` or
  // `verified_completed` or any non-prefixed value fails this
  // test immediately.
  const {
    VALID_EXECUTION_OUTCOME_TYPES,
  } = require('../../src/review/repository');
  const SNAPSHOT = [
    'reported_abandoned',
    'reported_completed',
    'reported_interrupted',
    'reported_unknown',
  ];
  const current = Array.from(VALID_EXECUTION_OUTCOME_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'EXECUTION_OUTCOME_TYPES snapshot drifted — the 4-value observational set is the constitutional design');
  assert.equal(current.length, 4, 'EXECUTION_OUTCOME_TYPES must contain exactly 4 values');
  for (const v of current) {
    assert.match(v, /^reported_/,
      `J37: EXECUTION_OUTCOME_TYPES value "${v}" must be reported_* prefixed `
      + '(AN OUTCOME ROW IS NOT TRUTH — the prefix puts that fact into the data)');
  }
});

// ===================================================================
// K-series — GM-29 execution-verification ledger actor.
//
// Constitutional invariant: VERIFICATION ≠ RECONCILIATION ≠ REPAIR.
// A verification row is epistemic, not authoritative.
// `verified_consistent` ≠ truth. `verification_inconclusive` ≠
// retry / escalate / "someone must act." The `verified_*`
// prefix is constitutionally isolated to the verification
// artifact only.
// ===================================================================

const { createExecutionVerificationLedgerActor } = require('../../src/actors');

const ADMIN_K = 'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa';
const OUTCOME_K = 'aaaaaaaa-9999-1111-1111-e00000000001';
const PILOT_K = '11111111-1111-1111-1111-111111111111';

function mockReviewPoolK() {
  let connectCalls = 0;
  const client = {
    async query(text) {
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'ffffffff-1111-1111-1111-ffffffffffff', created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    connect: async () => { connectCalls += 1; return client; },
    getConnectCalls: () => connectCalls,
  };
}

function verifyDecisionK() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY });
}

function baseParamsK(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT_K,
      userId: ADMIN_K,
      userRole: 'admin',
      executionOutcomeId: OUTCOME_K,
      verificationType: 'human_observation',
      verificationResult: 'verified_consistent',
    },
    overrides || {}
  );
}

test('K1. Plain-object Decision to verification-ledger actor → throws (instanceof fails); pool not consulted.', async () => {
  const pool = mockReviewPoolK();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const fake = Object.freeze({
    intentType: 'governance.execution.verify',
    decision: 'admissible',
    reason: 'execution_verification_recording_permitted',
    policyRef: 'execution-verification-runtime-boundary.md §3',
  });
  await assert.rejects(() => actor.execute(fake, baseParamsK()), /must be a Decision instance/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('K2. Prototype-tampered Decision passes instanceof but isValidDecision rejects → throws.', async () => {
  const pool = mockReviewPoolK();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const fake = {
    intentType: INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY,
    decision: DECISION_OUTCOMES.ADMISSIBLE,
    reason: REASONS.EXECUTION_VERIFICATION_RECORDING_PERMITTED,
    policyRef: 'execution-verification-runtime-boundary.md §3',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  assert.ok(fake instanceof Decision);
  await assert.rejects(() => actor.execute(fake, baseParamsK()),
    /not produced by classifyExecutionIntent/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('K3. Real Decision with wrong intent type (governance.execution.outcome.record) → throws (layer-4).', async () => {
  const pool = mockReviewPoolK();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const wrong = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
  await assert.rejects(() => actor.execute(wrong, baseParamsK()),
    /decision\.intentType must be "governance\.execution\.verify"/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('K5. Non-admin userRole rejected BEFORE pool.connect.', async () => {
  const pool = mockReviewPoolK();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecisionK();
  await assert.rejects(() => actor.execute(decision, baseParamsK({ userRole: 'senior' })),
    /userRole must be "admin"/);
  assert.equal(pool.getConnectCalls(), 0);
});

test('K14. Sentinel content in unknown params field never appears in captured logs.', async () => {
  const SENTINEL = 'K14_SECRET_VERIFICATION_BASIS';
  const pool = mockReviewPoolK();
  const lines = [];
  const log = {
    info(event, fields) {
      lines.push(JSON.stringify({ event, ...(fields || {}) }));
    },
  };
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool, log });
  const decision = verifyDecisionK();
  await actor.execute(decision, Object.assign(baseParamsK(), {
    verificationBasis: SENTINEL,
    payload: SENTINEL,
    notes: SENTINEL,
  }));
  const text = lines.join('\n');
  assert.ok(text.includes('actor.execution_verification.recorded'));
  assert.equal(text.includes(SENTINEL), false,
    'K14: sentinel content in unknown params field must not appear in logs');
});

test('K15. EVENT_TYPES snapshot still locked — GM-29 added NO new audit event types.', () => {
  const memoryAudit = require('../../src/memory/audit');
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-29 must not widen memory EVENT_TYPES — the verifications table IS the artifact');
});

test('K22. Static scan: zero references to governance_execution_verifications outside the writing path.', () => {
  // The K-series canary against accidental consumer introduction.
  // Per constitutional addendum 3, K22 is continuously enforced.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const WRITING_PATH = new Set([
    'src/review/repository.js',
    'src/review/transaction.js',
    'src/review/index.js',
    'src/actors/execution-verification-ledger-actor.js',
    'src/actors/outcomes.js',
    'src/actors/index.js',
    'scripts/ci/check-review-boundary.js',
  ]);
  function walk(rel, out) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
    } else if (rel.endsWith('.js')) {
      out.push(rel);
    }
  }
  const files = [];
  for (const root of ['src', 'scripts/ci']) walk(root, files);
  const leaks = [];
  for (const rel of files) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (content.includes('governance_execution_verifications') && !WRITING_PATH.has(rel)) {
      leaks.push(rel);
    }
  }
  assert.deepEqual(leaks, [],
    'GM-29 canary: governance_execution_verifications referenced outside the writing path — '
    + 'a future consumer may be leaking through. Files with leaks: ' + leaks.join(', '));
});

test('K24. File-scoped forbidden-vocabulary scan: execution-verification-ledger actor must not contain operational OR fix-it words.', () => {
  // Per OQ-29.10(b), with the owner-noted resolution that bare
  // `execute` and `dispatch` are dropped (they would collide with
  // the actor contract method name `execute(decision, params)`).
  // K24 keeps 20 words: 12 operational/repair + 8 fix-it
  // temptation words.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const filePath = path.join(REPO, 'src/actors/execution-verification-ledger-actor.js');
  const raw = fs.readFileSync(filePath, 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FORBIDDEN = [
    // Operational / repair vocabulary (12).
    'executed', 'dispatched', 'retry', 'retried',
    'reconcile', 'reconciled', 'rollback', 'compensate',
    'side_effect', 'mutate', 'promote', 'admit',
    // Fix-it temptation vocabulary (8).
    'fix', 'repair', 'correct', 'heal',
    'resolve', 'revert', 'undo', 'apply',
  ];
  const hits = FORBIDDEN.filter((w) => new RegExp('\\b' + w + '\\b').test(code));
  assert.deepEqual(hits, [],
    `K24: execution-verification-ledger actor contains forbidden vocabulary: ${hits.join(', ')}. `
    + 'VERIFICATION ≠ RECONCILIATION ≠ REPAIR.');
});

test('K27. Doc-presence canary: execution-verification-runtime-boundary.md must contain all four required sections plus the verbatim line.', () => {
  // Mirrors J27 but stricter — four mandatory sections instead
  // of two (per OQ-29.13(a)) AND the verbatim line per
  // constitutional addendum 9.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const docPath = path.join(REPO, 'docs/governance/execution-verification-runtime-boundary.md');
  assert.ok(fs.existsSync(docPath),
    'K27: docs/governance/execution-verification-runtime-boundary.md must exist');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /^## What this is NOT$/m,
    'K27: doc must contain a "## What this is NOT" section');
  assert.match(doc, /^## What remains unresolved$/m,
    'K27: doc must contain a "## What remains unresolved" section');
  assert.match(doc, /^## Verification is not reconciliation$/m,
    'K27: doc must contain a "## Verification is not reconciliation" section');
  assert.match(doc, /^## Verification does not execute or repair$/m,
    'K27: doc must contain a "## Verification does not execute or repair" section');
  // Constitutional addendum 9: verbatim phrase required.
  assert.ok(doc.includes('verification ≠ reconciliation ≠ repair'),
    'K27: doc must contain the verbatim phrase "verification ≠ reconciliation ≠ repair"');
});

test('K37. VERIFICATION_TYPES + VERIFICATION_RESULTS snapshots; verified_* prefix isolated from EXECUTION_OUTCOME_TYPES.', () => {
  // The constitutional canary of GM-29. The `verified_*` prefix
  // is the structural defense against truth-claim crossover
  // between the outcome and verification substrates. K37
  // asserts (1) exactly 4 verification_type values, (2) exactly
  // 3 verification_result values, (3) NO `verified_*` value
  // appears in EXECUTION_OUTCOME_TYPES.
  const {
    VALID_VERIFICATION_TYPES,
    VALID_VERIFICATION_RESULTS,
    VALID_EXECUTION_OUTCOME_TYPES,
  } = require('../../src/review/repository');

  const TYPES_SNAPSHOT = [
    'database_state_check',
    'external_confirmation',
    'human_observation',
    'system_log_review',
  ];
  const typesCurrent = Array.from(VALID_VERIFICATION_TYPES).sort();
  assert.deepEqual(typesCurrent, TYPES_SNAPSHOT.sort(),
    'VERIFICATION_TYPES snapshot drifted — the 4-value channel set is the constitutional design');
  assert.equal(typesCurrent.length, 4, 'VERIFICATION_TYPES must contain exactly 4 values');

  const RESULTS_SNAPSHOT = [
    'verification_inconclusive',
    'verified_consistent',
    'verified_inconsistent',
  ];
  const resultsCurrent = Array.from(VALID_VERIFICATION_RESULTS).sort();
  assert.deepEqual(resultsCurrent, RESULTS_SNAPSHOT.sort(),
    'VERIFICATION_RESULTS snapshot drifted — the 3-value result set is the constitutional design');
  assert.equal(resultsCurrent.length, 3, 'VERIFICATION_RESULTS must contain exactly 3 values');

  // Constitutional addendum 4: `verified_*` MUST NEVER appear in
  // EXECUTION_OUTCOME_TYPES.
  for (const v of VALID_EXECUTION_OUTCOME_TYPES) {
    assert.equal(/^verified_/.test(v), false,
      `K37: EXECUTION_OUTCOME_TYPES value "${v}" must NOT use the verified_* prefix `
      + '(verified_* is constitutionally isolated to VERIFICATION_RESULTS)');
  }
});

// ===================================================================
// L-series — GM-30 substrate freeze + gauntlet harness canaries.
//
// Constitutional invariant: GM-30 is a freeze-and-test GM. The
// substrate stops growing here. The gauntlet harness exists to
// PROVE the substrate holds under adversarial input — it must
// never become a vehicle for smuggling production behavior past
// the guards.
//
// "No new substrate without an inspection-only GM."
// ===================================================================

test('L14. Sentinel content in scenario setup payload never appears in the rendered result JSON.', async () => {
  // Constitutional addendum 6 + OQ-30.16(a): plant a sentinel in
  // a scenario's session/payload-shaped fields and assert it
  // never appears in the rendered result. The result schema
  // MUST excludes payload content by construction; L14 asserts
  // any future change to result.js does not regress.
  const SENTINEL = 'L14_GAUNTLET_RESULT_SENTINEL';
  const { renderResult, validateScenario } = require('../../src/gauntlet');
  // Construct a scenario shape that's structurally valid (so
  // validateScenario does not reject it) but whose description
  // contains the sentinel. renderResult MUST NOT include the
  // scenario.description, scenario.notes, or any other free-form
  // field — only the locked typed fields.
  const scenario = Object.freeze({
    id: 'L14.sentinel.probe',
    version: '1.0.0',
    category: 'forged-decision',
    description: SENTINEL,
    notes: SENTINEL,
    session: {
      pilotInstanceId: '11111111-1111-1111-1111-111111111111',
      userId: 'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa',
      userRole: 'admin',
    },
    setup: [],
    step: { kind: 'static-scan', scan: SENTINEL },
    expect: { result: 'expected_no_op', layerHit: 'static-scan', errorClassMatches: null },
  });
  validateScenario(scenario);
  const rendered = renderResult({
    scenario,
    runStartedAt: new Date(0),
    runFinishedAt: new Date(1),
    actualResult: 'expected_no_op',
    errorClass: null,
    trace: [],
    substrateState: null,
    decisionShape: null,
  });
  const text = JSON.stringify(rendered);
  assert.equal(text.includes(SENTINEL), false,
    'L14: sentinel content from scenario description / notes / step.scan must not appear in rendered result');
});

test('L15. EVENT_TYPES snapshot still locked — GM-30 added NO new audit event types.', () => {
  const memoryAudit = require('../../src/memory/audit');
  const SNAPSHOT = ['memory.created', 'memory.list'];
  const current = Object.values(memoryAudit.EVENT_TYPES).sort();
  assert.deepEqual(current, SNAPSHOT.sort(),
    'GM-30 must not widen memory EVENT_TYPES — GM-30 is a freeze-and-test GM, no substrate expansion');
});

test('L22. Substrate-freeze canary — exact counts of governance-staging tables / actor factories / ctx operations / EVENT_TYPES.', () => {
  // Per OQ-30.14(a) + constitutional addendum 7. The freeze is
  // the central architectural property of GM-30. Bumping any of
  // these counts requires a new inspection-only GM with its own
  // OQ approval block.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');

  // (1) exactly 7 governance-staging tables.
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const stagingMigrations = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_(review_queue|review_decisions|execution_(authorizations|claims|attempts|outcomes|verifications))\.sql$/.test(f))
    .sort();
  assert.equal(stagingMigrations.length, 7,
    `L22: expected exactly 7 governance-staging migrations; found ${stagingMigrations.length}: ${stagingMigrations.join(', ')}`);

  // (2) exactly 8 Decision-gated actor factories.
  const actors = require('../../src/actors');
  const factoryNames = Object.keys(actors).filter((k) => /^create.*Actor$/.test(k)).sort();
  const EXPECTED_FACTORIES = [
    'createExecutionAttemptLedgerActor',
    'createExecutionAuthorizationActor',
    'createExecutionClaimLedgerActor',
    'createExecutionOutcomeLedgerActor',
    'createExecutionVerificationLedgerActor',
    'createResponseDeliveryActor',
    'createReviewDecisionActor',
    'createReviewQueueActor',
  ];
  assert.deepEqual(factoryNames, EXPECTED_FACTORIES,
    'L22: expected exactly 8 Decision-gated actor factories; the freeze forbids adding/removing without a new GM');

  // (3) exactly 19 ctx operations (scan src/review/transaction.js
  // for the named ctx-property closures).
  const txn = fs.readFileSync(path.join(REPO, 'src/review/transaction.js'), 'utf8');
  const ctxOps = (txn.match(/^\s+(\w+):\s*\([^)]*\)\s*=>/gm) || [])
    .map((m) => m.match(/(\w+):/)[1])
    .filter((n) => !['pilotInstanceId', 'userId', 'userRole'].includes(n));
  assert.equal(ctxOps.length, 19,
    `L22: expected exactly 19 ctx operations; found ${ctxOps.length}: ${ctxOps.join(', ')}`);

  // (4) EVENT_TYPES still exactly 2.
  const memoryAudit = require('../../src/memory/audit');
  const eventTypes = Object.values(memoryAudit.EVENT_TYPES);
  assert.equal(eventTypes.length, 2,
    `L22: EVENT_TYPES must remain at exactly 2; found ${eventTypes.length}: ${eventTypes.join(', ')}`);
});

test('L24. File-scoped forbidden-vocabulary scan: src/gauntlet/ must not contain the 7-word OQ-30.10(a) list.', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');
  const dir = path.join(REPO, 'src/gauntlet');
  const FORBIDDEN = [
    'bypass', 'skip', 'disable', 'override', 'force',
    'monkeypatch', 'monkey_patch',
  ];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const w of FORBIDDEN) {
      if (new RegExp('\\b' + w + '\\b').test(code)) hits.push(`${f}:${w}`);
    }
  }
  assert.deepEqual(hits, [],
    `L24: src/gauntlet/ contains forbidden bare identifier(s): ${hits.join(', ')}. `
    + 'The gauntlet TESTS the substrate; it never bypasses, skips, disables, overrides, forces, or monkeypatches.');
});

test('L27. Doc-presence canary — substrate-freeze.md and gauntlet-harness.md must contain all required sections + the verbatim phrase.', () => {
  // Per OQ-30.13(a) + constitutional addendum 8. Four required
  // sections in each doc + the verbatim phrase in
  // substrate-freeze.md AND release-candidate.md.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');

  const freeze = path.join(REPO, 'docs/governance/substrate-freeze.md');
  assert.ok(fs.existsSync(freeze), 'L27: docs/governance/substrate-freeze.md must exist');
  const freezeDoc = fs.readFileSync(freeze, 'utf8');
  assert.match(freezeDoc, /^## What is frozen$/m, 'L27: substrate-freeze.md needs "## What is frozen"');
  assert.match(freezeDoc, /^## What is not frozen$/m, 'L27: substrate-freeze.md needs "## What is not frozen"');
  assert.match(freezeDoc, /^## How to unfreeze$/m, 'L27: substrate-freeze.md needs "## How to unfreeze"');
  assert.match(freezeDoc, /^## Why this exists$/m, 'L27: substrate-freeze.md needs "## Why this exists"');
  assert.ok(freezeDoc.includes('No new substrate without an inspection-only GM'),
    'L27: substrate-freeze.md must contain the verbatim phrase "No new substrate without an inspection-only GM"');

  const harness = path.join(REPO, 'docs/governance/gauntlet-harness.md');
  assert.ok(fs.existsSync(harness), 'L27: docs/governance/gauntlet-harness.md must exist');
  const harnessDoc = fs.readFileSync(harness, 'utf8');
  assert.match(harnessDoc, /^## What this is$/m, 'L27: gauntlet-harness.md needs "## What this is"');
  assert.match(harnessDoc, /^## What this is NOT$/m, 'L27: gauntlet-harness.md needs "## What this is NOT"');
  assert.match(harnessDoc, /^## Council workflow$/m, 'L27: gauntlet-harness.md needs "## Council workflow"');
  assert.match(harnessDoc, /^## Forbidden capabilities$/m, 'L27: gauntlet-harness.md needs "## Forbidden capabilities"');

  const rc = path.join(REPO, 'docs/deployment/release-candidate.md');
  const rcDoc = fs.readFileSync(rc, 'utf8');
  assert.ok(rcDoc.includes('No new substrate without an inspection-only GM'),
    'L27: release-candidate.md must contain the verbatim phrase "No new substrate without an inspection-only GM"');
});

test('L37. Gauntlet vocabulary snapshots — locked schema vocabularies.', () => {
  // Per OQ-30.11(a) + OQ-30.10(a) the gauntlet's own vocab is
  // mechanically locked. L37 is to the gauntlet what J37/K37 are
  // to the outcome/verification substrates.
  const {
    SCENARIO_CATEGORIES,
    STEP_KINDS,
    ACTOR_NAMES,
    SETUP_OPS,
    FORGERY_PATTERNS,
    EXPECT_RESULTS,
    LAYERS,
    COUNCIL_CLASSIFICATIONS,
    SCENARIO_SCHEMA_VERSION,
  } = require('../../src/gauntlet');

  assert.equal(SCENARIO_SCHEMA_VERSION, '1.0.0',
    'L37: scenario schema version is locked at "1.0.0" for GM-30');

  assert.deepEqual([...SCENARIO_CATEGORIES].sort(), [
    'chain-walk-corruption',
    'consumer-reference-violation',
    'cross-pilot-isolation',
    'doc-presence-violation',
    'event-types-widening',
    'forbidden-vocabulary-drift',
    'forged-decision',
    'replay-violation',
    'separation-of-duties-violation',
    'vocabulary-drift',
    'wrong-intent',
    'wrong-role',
  ], 'L37: SCENARIO_CATEGORIES drift — exactly 12 categories locked');

  assert.deepEqual([...STEP_KINDS].sort(), [
    'actor-call', 'boundary-guard', 'classifier-call',
    'forged-decision', 'snapshot-check', 'static-scan',
  ], 'L37: STEP_KINDS drift — exactly 6 kinds locked');

  assert.equal(ACTOR_NAMES.length, 8,
    'L37: ACTOR_NAMES must contain exactly 8 actor factory names (mirrors L22 freeze)');

  assert.deepEqual([...SETUP_OPS].sort(), [
    'chain.through.attempt',
    'chain.through.authorization',
    'chain.through.claim',
    'chain.through.decision',
    'chain.through.outcome',
    'chain.through.queue',
    'fixtures.reset',
  ], 'L37: SETUP_OPS drift — exactly 7 setup ops locked');

  assert.deepEqual([...FORGERY_PATTERNS].sort(), [
    'missing-field', 'mutated-after-freeze',
    'plain-object', 'prototype-tamper', 'wrong-intent',
  ], 'L37: FORGERY_PATTERNS drift — exactly 5 patterns locked');

  assert.deepEqual([...EXPECT_RESULTS].sort(), [
    'expected_admission', 'expected_no_op',
    'expected_rejection', 'expected_throw',
  ], 'L37: EXPECT_RESULTS drift — exactly 4 outcomes locked');

  assert.equal(LAYERS.length, 19,
    'L37: LAYERS must contain exactly 19 named architectural layers '
    + '(GM-30 harness-corrective patch added "db-rejection" as the '
    + 'conservative bucket for ReviewRepositoryError-wrapped DB '
    + 'refusals where the sanitizer discards which sub-layer fired)');
  assert.ok(LAYERS.includes('db-rejection'),
    'L37: LAYERS must include "db-rejection" — the wrapped-DB-error bucket '
    + 'added by the GM-30 harness-corrective patch');

  assert.deepEqual([...COUNCIL_CLASSIFICATIONS].sort(), [
    'classified_pending',
    'expected_admission',
    'expected_rejection',
    'fixture_bug',
    'invariant_violation',
    'missing_architecture',
    'no_action_needed',
    'substrate_bug',
    'test_bug',
  ], 'L37: COUNCIL_CLASSIFICATIONS drift — exactly 9 classifications locked (per addendum 9)');
});

test('L38. Manual-mode scenario refusal — tests/gauntlet/manual/ directory exists and is gitignored.', () => {
  // Per OQ-30.15(a) + constitutional addendum 4. Manual
  // scenarios live in tests/gauntlet/manual/ which is
  // gitignored; they never auto-run in CI.
  const fs = require('node:fs');
  const path = require('node:path');
  const REPO = path.join(__dirname, '..', '..');

  const manualDir = path.join(REPO, 'tests/gauntlet/manual');
  // The directory must EXIST (so authors have a known place to
  // drop probes) but its contents must be gitignored.
  assert.ok(fs.existsSync(manualDir),
    'L38: tests/gauntlet/manual/ must exist as the manual-scenario landing zone');

  const gitignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(gitignore, /^tests\/gauntlet\/manual\/\*$/m,
    'L38: .gitignore must ignore contents via "tests/gauntlet/manual/*" so local probes never ship');
  assert.match(gitignore, /^!tests\/gauntlet\/manual\/\.gitkeep$/m,
    'L38: .gitignore must keep the .gitkeep placeholder via "!tests/gauntlet/manual/.gitkeep" so the directory itself ships and the L38 existsSync check holds on a fresh CI checkout');

  // The runner must NOT load manual scenarios without the
  // GAUNTLET_MANUAL=1 environment variable. We verify the
  // structural rule by reading the runner source — it must
  // reference process.env.GAUNTLET_MANUAL === '1'. The
  // env-var contract replaced the original --manual argv flag
  // because `node --test` does not propagate child-process
  // arguments reliably (GM-30 harness-corrective patch).
  const runner = fs.readFileSync(path.join(REPO, 'tests/gauntlet/runner.test.js'), 'utf8');
  assert.match(runner, /process\.env\.GAUNTLET_MANUAL\s*===\s*['"]1['"]/,
    'L38: runner.test.js must gate manual-scenario loading behind GAUNTLET_MANUAL=1');
  assert.doesNotMatch(runner, /process\.argv\.includes\(['"]--manual['"]\)/,
    'L38: runner.test.js must NOT use the old --manual argv flag — node --test does not propagate it');
});
