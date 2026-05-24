'use strict';
/*
 * Decision shape, vocabulary, and opaque-factory pattern — GM-21.
 *
 * The Decision class is the only typed proof of governance
 * classification. Future actor modules will require a Decision
 * instance (not a raw intent) as their input contract — the same
 * opaque-handle pattern GM-18 introduced for MemoryPoolHandle.
 *
 * Decision construction is gated by a module-private Symbol token.
 * External callers cannot reach the token; only the classifier (in
 * ./classifier.js) can. A caller who tries `new Decision(...)` from
 * outside this module gets a thrown error.
 *
 * The Decision carries:
 *   - intentType — echoes the input intent.type (for actor
 *     type-confusion checks)
 *   - decision   — 'admissible' | 'requires_review' | 'inadmissible'
 *   - reason     — a REASONS-vocabulary value
 *   - policyRef  — a citation, looked up from POLICY_REFS by reason
 *
 * The Decision deliberately does NOT carry the intent's payload or
 * evidence — those may contain memory content the Decision must not
 * echo. See docs/governance/governance-runtime-boundary.md §3.
 */

const DECISION_OUTCOMES = Object.freeze({
  ADMISSIBLE: 'admissible',
  REQUIRES_REVIEW: 'requires_review',
  INADMISSIBLE: 'inadmissible',
});

const ALL_DECISION_OUTCOMES = new Set(Object.values(DECISION_OUTCOMES));

// Locked REASONS vocabulary. Adding a new reason requires:
//   1. Adding the constant here.
//   2. Adding the paired POLICY_REFS entry below.
//   3. Adding the classifier branch that produces it.
//   4. Updating governance-runtime-boundary.md.
//
// The classifier validates that every Decision it constructs uses a
// REASONS member; an unknown reason throws (programmer error).
const REASONS = Object.freeze({
  RESPONSE_DELIVERY_PERMITTED: 'response_delivery_permitted',
  AI_INFERRED_REQUIRES_REVIEW: 'ai_inferred_requires_review',
  USER_STATED_REQUIRES_REVIEW: 'user_stated_requires_review',
  VERIFIED_FACT_SELF_PROMOTION_FORBIDDEN: 'verified_fact_self_promotion_forbidden',
  VISIBILITY_PROMOTION_REQUIRES_AUTHORITY: 'visibility_promotion_requires_authority',
  RETRACTION_INFRASTRUCTURE_NOT_AVAILABLE: 'retraction_infrastructure_not_available',
  SUPERSESSION_INFRASTRUCTURE_NOT_AVAILABLE: 'supersession_infrastructure_not_available',
  VAULT_INFRASTRUCTURE_NOT_AVAILABLE: 'vault_infrastructure_not_available',
  EXTERNAL_SIDE_EFFECTS_NOT_AUTHORIZED: 'external_side_effects_not_authorized',
  UNKNOWN_INTENT_TYPE: 'unknown_intent_type',
  MALFORMED_INTENT_PAYLOAD: 'malformed_intent_payload',
  // GM-24: the classifier admits GOVERNANCE_REVIEW_DECIDE intents
  // so the review-decision actor has a Decision to verify. The
  // actor enforces admin-only role; the classifier is stateless.
  REVIEW_DECISION_RECORDING_PERMITTED: 'review_decision_recording_permitted',
});

const ALL_REASONS = new Set(Object.values(REASONS));

// Each REASON has a stable citation into the governance docs. A
// caller (or auditor) can look up why a Decision came back the way
// it did.
const POLICY_REFS = Object.freeze({
  [REASONS.RESPONSE_DELIVERY_PERMITTED]:
    'conversation-runtime-boundary.md §5',
  [REASONS.AI_INFERRED_REQUIRES_REVIEW]:
    'source-of-truth-memory-policy.md §3, §5',
  [REASONS.USER_STATED_REQUIRES_REVIEW]:
    'source-of-truth-memory-policy.md §4',
  [REASONS.VERIFIED_FACT_SELF_PROMOTION_FORBIDDEN]:
    'source-of-truth-memory-policy.md §2, §3',
  [REASONS.VISIBILITY_PROMOTION_REQUIRES_AUTHORITY]:
    'source-of-truth-memory-policy.md §12',
  [REASONS.RETRACTION_INFRASTRUCTURE_NOT_AVAILABLE]:
    'source-of-truth-memory-policy.md §6',
  [REASONS.SUPERSESSION_INFRASTRUCTURE_NOT_AVAILABLE]:
    'source-of-truth-memory-policy.md §7',
  [REASONS.VAULT_INFRASTRUCTURE_NOT_AVAILABLE]:
    'source-of-truth-memory-policy.md §13',
  [REASONS.EXTERNAL_SIDE_EFFECTS_NOT_AUTHORIZED]:
    'governance-runtime-boundary.md §7',
  [REASONS.UNKNOWN_INTENT_TYPE]:
    'governance-runtime-boundary.md §3 (default-deny)',
  [REASONS.MALFORMED_INTENT_PAYLOAD]:
    'governance-runtime-boundary.md §3 (default-deny)',
  [REASONS.REVIEW_DECISION_RECORDING_PERMITTED]:
    'review-decision-runtime-boundary.md §3',
});

// Module-private token. External code cannot reach this Symbol —
// the only way to obtain a Decision is via _createDecision below,
// which the classifier calls.
const _TOKEN = Symbol('Decision._INTERNAL_CONSTRUCTION_TOKEN');

// Module-private WeakSet of every Decision the classifier has
// produced. The actor's verification step consults this set to
// confirm an `instanceof Decision` candidate was actually created
// by `_createDecision` — and not by an attacker who set the
// prototype of a hand-built object to `Decision.prototype`.
//
// The WeakSet is private to this module: external code cannot add
// to it, and `isValidDecision` is the only way to query it.
const _BLESSED = new WeakSet();

class Decision {
  constructor(token, fields) {
    if (token !== _TOKEN) {
      throw new Error(
        'Decision: cannot be constructed externally; obtain one via classifyExecutionIntent'
      );
    }
    if (!fields || typeof fields !== 'object') {
      throw new Error('Decision: fields object is required');
    }
    const { intentType, decision, reason } = fields;
    if (typeof intentType !== 'string' || intentType.trim() === '') {
      throw new Error('Decision: intentType must be a non-empty string');
    }
    if (!ALL_DECISION_OUTCOMES.has(decision)) {
      throw new Error(
        `Decision: outcome must be one of ${Array.from(ALL_DECISION_OUTCOMES).join(', ')}`
      );
    }
    if (!ALL_REASONS.has(reason)) {
      throw new Error(
        `Decision: reason must be a member of REASONS (got "${reason}")`
      );
    }
    this.intentType = intentType;
    this.decision = decision;
    this.reason = reason;
    this.policyRef = POLICY_REFS[reason];
    Object.freeze(this);
  }
}

// Closes the prototype-tampering gap: an attacker can construct
// `{intentType, decision, reason, policyRef}` and call
// `Object.setPrototypeOf(fake, Decision.prototype)` to make the
// resulting object pass `instanceof Decision`. The WeakSet check
// returns false for any object that did not go through
// `_createDecision` below, because only that path adds to the set.
function isValidDecision(value) {
  return value instanceof Decision && _BLESSED.has(value);
}

// Internal factory the classifier calls. Not re-exported through
// src/governance/index.js; callers cannot construct decisions
// themselves. Every Decision produced here is registered in the
// _BLESSED WeakSet so the actor's `isValidDecision` check can
// distinguish classifier-produced instances from prototype-tampered
// imposters.
function _createDecision(fields) {
  const d = new Decision(_TOKEN, fields);
  _BLESSED.add(d);
  return d;
}

module.exports = {
  Decision,
  DECISION_OUTCOMES,
  ALL_DECISION_OUTCOMES,
  REASONS,
  ALL_REASONS,
  POLICY_REFS,
  isValidDecision,
  _createDecision,
};
