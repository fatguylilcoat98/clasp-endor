'use strict';
/*
 * Unit tests for classifyExecutionIntent — the GM-21 pure
 * governance-decision function.
 *
 * No I/O, no DB, no model SDK.
 *
 * What these tests prove:
 *   - the classifier is pure (same input → identical output across
 *     N calls);
 *   - the classifier classifies each enumerated intent type per the
 *     policy table in docs/governance/governance-runtime-boundary.md;
 *   - the classifier returns admissible only for response.deliver and
 *     never for any irreversible intent type;
 *   - default-deny: unknown intent types and malformed inputs return
 *     inadmissible (the classifier never throws — fail-closed);
 *   - the Decision is opaque/unforgeable: callers cannot construct a
 *     Decision externally;
 *   - the Decision is frozen and carries only typed metadata
 *     (intentType, decision, reason, policyRef) — NEVER payload or
 *     evidence;
 *   - the Decision's reason is always a member of REASONS;
 *   - the Decision's policyRef is always a valid citation;
 *   - sentinel content planted in intent.payload and intent.evidence
 *     does NOT leak into the returned Decision OR into any side
 *     channel (the classifier emits no stdout — captured and
 *     asserted empty).
 *   - src/governance/index re-exports only the approved surface;
 *     never `_createDecision` or any internal factory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../../src/governance');
const {
  classifyExecutionIntent,
  Decision,
  INTENT_TYPES,
  DECISION_OUTCOMES,
  REASONS,
} = governance;

// ---- index.js public surface ----

test('index: re-exports the approved surface only', () => {
  assert.equal(typeof governance.classifyExecutionIntent, 'function');
  assert.equal(typeof governance.Decision, 'function');
  assert.equal(typeof governance.INTENT_TYPES, 'object');
  assert.equal(typeof governance.DECISION_OUTCOMES, 'object');
  assert.equal(typeof governance.REASONS, 'object');
  // Internal factory must NOT be re-exported.
  assert.equal(governance._createDecision, undefined);
  assert.equal(governance._TOKEN, undefined);
});

test('index: INTENT_TYPES, DECISION_OUTCOMES, REASONS are all frozen', () => {
  assert.equal(Object.isFrozen(INTENT_TYPES), true);
  assert.equal(Object.isFrozen(DECISION_OUTCOMES), true);
  assert.equal(Object.isFrozen(REASONS), true);
});

// ---- Decision opacity / forgeability ----

test('Decision: cannot be constructed externally — the constructor throws without the internal token', () => {
  assert.throws(
    () => new Decision('any', { intentType: 'x', decision: 'admissible', reason: 'r' }),
    /cannot be constructed externally/
  );
  assert.throws(() => new Decision(), /cannot be constructed externally/);
  assert.throws(() => new Decision(null, null), /cannot be constructed externally/);
});

test('Decision: returned by the classifier is instanceof-checkable', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  assert.ok(d instanceof Decision);
});

test('Decision: returned by the classifier is frozen — cannot be mutated', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  assert.equal(Object.isFrozen(d), true);
  assert.throws(() => {
    d.decision = 'inadmissible';
  });
  assert.throws(() => {
    d.foo = 'bar';
  });
});

test('Decision: carries only the typed metadata fields — no payload, no evidence', () => {
  const d = classifyExecutionIntent({
    type: INTENT_TYPES.RESPONSE_DELIVER,
    payload: { secret: 'PAYLOAD_DO_NOT_LEAK_111' },
    evidence: { secret: 'EVIDENCE_DO_NOT_LEAK_222' },
  });
  const keys = Object.keys(d).sort();
  assert.deepEqual(keys, ['decision', 'intentType', 'policyRef', 'reason']);
  assert.equal(d.payload, undefined, 'Decision must not carry payload');
  assert.equal(d.evidence, undefined, 'Decision must not carry evidence');
  // Sanity: no field on the Decision contains the planted secrets.
  const serialized = JSON.stringify(d);
  assert.equal(serialized.includes('PAYLOAD_DO_NOT_LEAK_111'), false);
  assert.equal(serialized.includes('EVIDENCE_DO_NOT_LEAK_222'), false);
});

// ---- Classifier purity / determinism / no side effects ----

test('classifier: pure — N identical inputs yield N identical Decisions', () => {
  const inputs = [
    { type: INTENT_TYPES.RESPONSE_DELIVER },
    {
      type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
      payload: { provenance: 'AI_INFERRED' },
    },
    { type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE },
    { type: INTENT_TYPES.EXTERNAL_SIDE_EFFECT },
    { type: 'some.unknown.type' },
  ];
  for (const intent of inputs) {
    const a = classifyExecutionIntent(intent);
    const b = classifyExecutionIntent(intent);
    const c = classifyExecutionIntent(intent);
    // Same metadata across calls.
    assert.deepEqual(
      { decision: a.decision, reason: a.reason, intentType: a.intentType, policyRef: a.policyRef },
      { decision: b.decision, reason: b.reason, intentType: b.intentType, policyRef: b.policyRef }
    );
    assert.deepEqual(
      { decision: a.decision, reason: a.reason, intentType: a.intentType, policyRef: a.policyRef },
      { decision: c.decision, reason: c.reason, intentType: c.intentType, policyRef: c.policyRef }
    );
  }
});

test('classifier: no side effects — never writes to stdout', () => {
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    for (const intent of [
      { type: INTENT_TYPES.RESPONSE_DELIVER },
      { type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE, payload: { provenance: 'AI_INFERRED' } },
      { type: INTENT_TYPES.EXTERNAL_SIDE_EFFECT },
      { type: 'whatever' },
      null,
      undefined,
      {},
      { type: 42 },
    ]) {
      classifyExecutionIntent(intent);
    }
  } finally {
    process.stdout.write = original;
  }
  assert.equal(captured.length, 0, 'classifier must emit nothing to stdout');
});

// ---- response.deliver: the only admissible default ----

test('response.deliver: admissible with reason response_delivery_permitted', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  assert.equal(d.decision, DECISION_OUTCOMES.ADMISSIBLE);
  assert.equal(d.reason, REASONS.RESPONSE_DELIVERY_PERMITTED);
  assert.equal(d.intentType, INTENT_TYPES.RESPONSE_DELIVER);
  assert.match(d.policyRef, /conversation-runtime-boundary\.md/);
});

// ---- memory.candidate.create per provenance ----

test('memory.candidate.create AI_INFERRED → requires_review', () => {
  const d = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  assert.equal(d.decision, DECISION_OUTCOMES.REQUIRES_REVIEW);
  assert.equal(d.reason, REASONS.AI_INFERRED_REQUIRES_REVIEW);
  assert.match(d.policyRef, /source-of-truth-memory-policy\.md/);
});

test('memory.candidate.create USER_STATED → requires_review', () => {
  const d = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'USER_STATED' },
  });
  assert.equal(d.decision, DECISION_OUTCOMES.REQUIRES_REVIEW);
  assert.equal(d.reason, REASONS.USER_STATED_REQUIRES_REVIEW);
});

test('memory.candidate.create VERIFIED_FACT → inadmissible (model self-promotion forbidden, §3)', () => {
  const d = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'VERIFIED_FACT' },
  });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.VERIFIED_FACT_SELF_PROMOTION_FORBIDDEN);
});

test('memory.candidate.create with malformed/missing provenance → inadmissible (malformed_intent_payload)', () => {
  for (const payload of [undefined, null, {}, { provenance: 'GOSSIP' }, { provenance: 42 }]) {
    const intent = { type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE, payload };
    const d = classifyExecutionIntent(intent);
    assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
    assert.equal(d.reason, REASONS.MALFORMED_INTENT_PAYLOAD);
  }
});

// ---- every irreversible intent type → inadmissible ----

test('memory.visibility.promote → inadmissible (visibility_promotion_requires_authority)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.VISIBILITY_PROMOTION_REQUIRES_AUTHORITY);
});

test('memory.retract → inadmissible (retraction_infrastructure_not_available)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_RETRACT });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.RETRACTION_INFRASTRUCTURE_NOT_AVAILABLE);
});

test('memory.supersede → inadmissible (supersession_infrastructure_not_available)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_SUPERSEDE });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.SUPERSESSION_INFRASTRUCTURE_NOT_AVAILABLE);
});

test('vault.session.open → inadmissible (vault_infrastructure_not_available)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.VAULT_SESSION_OPEN });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.VAULT_INFRASTRUCTURE_NOT_AVAILABLE);
});

test('vault.session.revoke → inadmissible (vault_infrastructure_not_available)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.VAULT_SESSION_REVOKE });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.VAULT_INFRASTRUCTURE_NOT_AVAILABLE);
});

test('external.side_effect → inadmissible (external_side_effects_not_authorized)', () => {
  const d = classifyExecutionIntent({ type: INTENT_TYPES.EXTERNAL_SIDE_EFFECT });
  assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
  assert.equal(d.reason, REASONS.EXTERNAL_SIDE_EFFECTS_NOT_AUTHORIZED);
});

// ---- default-deny ----

test('default-deny: unknown intent type → inadmissible (unknown_intent_type)', () => {
  for (const type of ['memory.delete_everything', 'agent.spawn', 'tool.call', 'mystery.action']) {
    const d = classifyExecutionIntent({ type });
    assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
    assert.equal(d.reason, REASONS.UNKNOWN_INTENT_TYPE);
    assert.equal(d.intentType, type, 'unknown intent type is echoed verbatim on the Decision');
  }
});

test('default-deny: malformed input → inadmissible (malformed_intent_payload) — classifier never throws', () => {
  for (const intent of [null, undefined, 'string', 42, true, {}, { type: 42 }, { type: null }]) {
    const d = classifyExecutionIntent(intent);
    assert.equal(d.decision, DECISION_OUTCOMES.INADMISSIBLE);
    assert.equal(d.reason, REASONS.MALFORMED_INTENT_PAYLOAD);
    assert.ok(d instanceof Decision);
  }
});

// ---- coverage: every INTENT_TYPES value has a classifier branch ----

test('coverage: every INTENT_TYPES value is classified (no fall-through to unknown_intent_type)', () => {
  for (const type of Object.values(INTENT_TYPES)) {
    // For memory.candidate.create, supply a valid provenance so the
    // classifier doesn't bail on malformed_intent_payload.
    const intent =
      type === INTENT_TYPES.MEMORY_CANDIDATE_CREATE
        ? { type, payload: { provenance: 'AI_INFERRED' } }
        : { type };
    const d = classifyExecutionIntent(intent);
    assert.notEqual(
      d.reason,
      REASONS.UNKNOWN_INTENT_TYPE,
      `INTENT_TYPES.${type} must have a classifier branch (got reason=${d.reason})`
    );
  }
});

// ---- Decision integrity: reason is always a REASONS member ----

test('integrity: every Decision the classifier returns has a REASONS-vocabulary reason and a non-empty policyRef', () => {
  const allReasons = new Set(Object.values(REASONS));
  const samples = [
    { type: INTENT_TYPES.RESPONSE_DELIVER },
    { type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE, payload: { provenance: 'AI_INFERRED' } },
    { type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE, payload: { provenance: 'USER_STATED' } },
    { type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE, payload: { provenance: 'VERIFIED_FACT' } },
    { type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE },
    { type: INTENT_TYPES.MEMORY_RETRACT },
    { type: INTENT_TYPES.MEMORY_SUPERSEDE },
    { type: INTENT_TYPES.VAULT_SESSION_OPEN },
    { type: INTENT_TYPES.VAULT_SESSION_REVOKE },
    { type: INTENT_TYPES.EXTERNAL_SIDE_EFFECT },
    { type: 'unknown.xyz' },
    null,
  ];
  for (const intent of samples) {
    const d = classifyExecutionIntent(intent);
    assert.ok(allReasons.has(d.reason), `reason "${d.reason}" must be a member of REASONS`);
    assert.equal(typeof d.policyRef, 'string');
    assert.ok(d.policyRef.length > 0, 'policyRef must be a non-empty citation');
  }
});

// ---- admissibility-before-execution: only one intent type is admissible by default ----

test('admissibility-before-execution: only response.deliver and governance.review.decide are admissible by default; everything else is requires_review or inadmissible', () => {
  const admissibleTypes = [];
  for (const type of Object.values(INTENT_TYPES)) {
    const intent =
      type === INTENT_TYPES.MEMORY_CANDIDATE_CREATE
        ? { type, payload: { provenance: 'AI_INFERRED' } }
        : { type };
    const d = classifyExecutionIntent(intent);
    if (d.decision === DECISION_OUTCOMES.ADMISSIBLE) admissibleTypes.push(type);
  }
  // GM-21 baseline: response.deliver only.
  // GM-24 addition: governance.review.decide (the actor enforces
  // admin-only role; the classifier is stateless and admits the
  // intent type unconditionally).
  assert.deepEqual(
    admissibleTypes.sort(),
    ['governance.review.decide', 'response.deliver'],
    'exactly two intent types should be admissible by default after GM-24'
  );
});

// ---- sentinel privacy: intent payload/evidence NEVER leak into Decision or stdout ----

test('sentinel privacy: planted payload/evidence content NEVER appears in the Decision or in any side channel', () => {
  const PAYLOAD_SENTINEL = 'SENTINEL_PAYLOAD_DO_NOT_LEAK_999';
  const EVIDENCE_SENTINEL = 'SENTINEL_EVIDENCE_DO_NOT_LEAK_888';

  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  let d;
  try {
    d = classifyExecutionIntent({
      type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
      payload: { provenance: 'AI_INFERRED', secret: PAYLOAD_SENTINEL },
      evidence: { rawModelOutput: EVIDENCE_SENTINEL },
    });
  } finally {
    process.stdout.write = original;
  }

  // The Decision should be admissibility-typed but carry no payload/evidence.
  const serializedDecision = JSON.stringify(d);
  assert.equal(serializedDecision.includes(PAYLOAD_SENTINEL), false, 'Decision must not echo payload');
  assert.equal(serializedDecision.includes(EVIDENCE_SENTINEL), false, 'Decision must not echo evidence');

  // The classifier must have emitted nothing to stdout.
  assert.equal(captured.length, 0, 'classifier must not write to stdout');
});

// ---- input invariance: extra payload/evidence fields don't change the Decision ----

test('classifier ignores extra payload/evidence fields it does not need (no behavioral coupling)', () => {
  const base = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
  const withJunk = classifyExecutionIntent({
    type: INTENT_TYPES.RESPONSE_DELIVER,
    payload: { irrelevant: true, blob: 'x'.repeat(10000) },
    evidence: { trace: ['a', 'b', 'c'] },
  });
  assert.deepEqual(
    {
      intentType: base.intentType,
      decision: base.decision,
      reason: base.reason,
      policyRef: base.policyRef,
    },
    {
      intentType: withJunk.intentType,
      decision: withJunk.decision,
      reason: withJunk.reason,
      policyRef: withJunk.policyRef,
    }
  );
});
