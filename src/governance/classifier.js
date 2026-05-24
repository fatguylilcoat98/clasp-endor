'use strict';
/*
 * classifyExecutionIntent — pure function that classifies a typed
 * intent into a Decision (admissible / requires_review / inadmissible).
 *
 * Hard properties:
 *   - Pure. No I/O. No DB. No model SDK. No mutable module state.
 *     Same input → identical Decision across N calls.
 *   - Stateless. The classifier sees the intent and nothing else;
 *     it does not consult history, rate counters, or external policy.
 *   - Deterministic. Every branch is enumerated; default-deny catches
 *     anything not enumerated.
 *   - Does not execute. The Decision is data; the caller (a future
 *     actor module, GM-22+) is responsible for honoring it.
 *   - Does not echo intent.payload or intent.evidence into the
 *     returned Decision (the Decision shape deliberately excludes
 *     those fields — see ./decisions.js).
 *
 * The classifier signature:
 *
 *   classifyExecutionIntent({type, payload?, evidence?}) → Decision
 *
 * Where:
 *   type     — one of INTENT_TYPES (string)
 *   payload  — intent-type-specific data; the classifier reads only
 *              the fields it needs to make a policy call.
 *   evidence — opaque traceability blob; the classifier does NOT
 *              read it (kept on the intent for the caller's audit
 *              record; never copied into the Decision).
 *
 * On malformed input (intent is not an object, or intent.type is not
 * a string), the classifier returns a Decision with reason
 * `malformed_intent_payload`. It does NOT throw — fail-closed is
 * the design.
 */

const {
  INTENT_TYPES,
  ALL_INTENT_TYPES,
  ALL_PROVENANCE_CLASSES,
  PROVENANCE_CLASSES,
} = require('./intents');
const {
  DECISION_OUTCOMES,
  REASONS,
  _createDecision,
} = require('./decisions');

function classifyMemoryCandidateCreate(intent) {
  // §2 / §3 forbid model self-promotion to VERIFIED_FACT. The
  // VERIFIED_FACT lifecycle is owned by the authority-validation
  // workflow, which is not the model's path.
  // §4 leaves USER_STATED admissibility as a deployment-owner
  // decision; the conservative default until per-instance config
  // arrives is `requires_review`.
  // §3 / §5 require AI_INFERRED to never auto-promote; route to
  // human review.
  const provenance = intent.payload && intent.payload.provenance;
  if (!ALL_PROVENANCE_CLASSES.has(provenance)) {
    return _createDecision({
      intentType: intent.type,
      decision: DECISION_OUTCOMES.INADMISSIBLE,
      reason: REASONS.MALFORMED_INTENT_PAYLOAD,
    });
  }
  if (provenance === PROVENANCE_CLASSES.VERIFIED_FACT) {
    return _createDecision({
      intentType: intent.type,
      decision: DECISION_OUTCOMES.INADMISSIBLE,
      reason: REASONS.VERIFIED_FACT_SELF_PROMOTION_FORBIDDEN,
    });
  }
  if (provenance === PROVENANCE_CLASSES.USER_STATED) {
    return _createDecision({
      intentType: intent.type,
      decision: DECISION_OUTCOMES.REQUIRES_REVIEW,
      reason: REASONS.USER_STATED_REQUIRES_REVIEW,
    });
  }
  // PROVENANCE_CLASSES.AI_INFERRED — exhaustive.
  return _createDecision({
    intentType: intent.type,
    decision: DECISION_OUTCOMES.REQUIRES_REVIEW,
    reason: REASONS.AI_INFERRED_REQUIRES_REVIEW,
  });
}

function classifyExecutionIntent(intent) {
  // Malformed-intent fail-closed. The classifier never throws on
  // bad input — it returns an inadmissible Decision with a typed
  // reason. The caller (or a future actor) honors it the same way
  // it would honor any other inadmissible result.
  if (!intent || typeof intent !== 'object' || typeof intent.type !== 'string') {
    return _createDecision({
      intentType: typeof (intent && intent.type) === 'string' ? intent.type : 'unknown',
      decision: DECISION_OUTCOMES.INADMISSIBLE,
      reason: REASONS.MALFORMED_INTENT_PAYLOAD,
    });
  }

  // Default-deny: unknown intent types are inadmissible.
  if (!ALL_INTENT_TYPES.has(intent.type)) {
    return _createDecision({
      intentType: intent.type,
      decision: DECISION_OUTCOMES.INADMISSIBLE,
      reason: REASONS.UNKNOWN_INTENT_TYPE,
    });
  }

  switch (intent.type) {
    case INTENT_TYPES.RESPONSE_DELIVER:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.ADMISSIBLE,
        reason: REASONS.RESPONSE_DELIVERY_PERMITTED,
      });

    case INTENT_TYPES.MEMORY_CANDIDATE_CREATE:
      return classifyMemoryCandidateCreate(intent);

    case INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.VISIBILITY_PROMOTION_REQUIRES_AUTHORITY,
      });

    case INTENT_TYPES.MEMORY_RETRACT:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.RETRACTION_INFRASTRUCTURE_NOT_AVAILABLE,
      });

    case INTENT_TYPES.MEMORY_SUPERSEDE:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.SUPERSESSION_INFRASTRUCTURE_NOT_AVAILABLE,
      });

    case INTENT_TYPES.VAULT_SESSION_OPEN:
    case INTENT_TYPES.VAULT_SESSION_REVOKE:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.VAULT_INFRASTRUCTURE_NOT_AVAILABLE,
      });

    case INTENT_TYPES.EXTERNAL_SIDE_EFFECT:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.EXTERNAL_SIDE_EFFECTS_NOT_AUTHORIZED,
      });

    case INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE:
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.ADMISSIBLE,
        reason: REASONS.REVIEW_DECISION_RECORDING_PERMITTED,
      });

    default:
      // Belt-and-suspenders: the type was in ALL_INTENT_TYPES (passed
      // the membership check above) but no branch matched. This is a
      // programmer error in this file (a constant was added to
      // INTENT_TYPES without a classifier branch). Fail closed.
      return _createDecision({
        intentType: intent.type,
        decision: DECISION_OUTCOMES.INADMISSIBLE,
        reason: REASONS.UNKNOWN_INTENT_TYPE,
      });
  }
}

module.exports = { classifyExecutionIntent };
