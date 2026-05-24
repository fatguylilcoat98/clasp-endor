'use strict';
/*
 * Response-delivery actor — GM-22.
 *
 * The first actor module. Wraps the GM-20 conversation runtime
 * with a Decision-gated entry point. The actor will not call the
 * runtime unless it is given a valid, classifier-produced,
 * unforged, unmutated, admissible Decision for the
 * `response.deliver` intent type.
 *
 * The actor is the FIRST mechanical enforcement that "you cannot
 * act without a Decision." The conversation runtime is still
 * independently callable in GM-22 (per OQ-22.8 — no API break),
 * but any caller that wants the governance check uses this actor.
 *
 * Five-layer Decision verification (OQ-22.3):
 *
 *   1. instanceof Decision               (primary type check)
 *   2. isValidDecision(decision)         (closes prototype-tampering
 *                                         gap via the classifier's
 *                                         WeakSet of blessed
 *                                         instances)
 *   3. Object.isFrozen(decision)         (catches mutation attempts)
 *   4. decision.intentType ===           (type-confusion check —
 *      INTENT_TYPES.RESPONSE_DELIVER     the actor refuses any
 *                                         Decision intended for a
 *                                         different intent type)
 *   5. decision.reason ∈ REASONS         (vocabulary check —
 *      decision.decision ∈                 redundant with the
 *      DECISION_OUTCOMES                   Decision constructor's
 *      typeof decision.policyRef ===       own checks, but defense in
 *        'string' && length > 0            depth in case a future
 *                                          refactor weakens those)
 *
 * On verification failure: THROW a programmer-error Error. A
 * forged or tampered Decision indicates broken caller code, not a
 * classification result — the caller should not be able to
 * "handle" this with a structured outcome.
 *
 * On verification success: route by decision.decision:
 *
 *   admissible       → call conversationRuntime.respond(params)
 *                       → outcome 'executed'
 *   requires_review  → return outcome 'abstained' (runtime NOT called)
 *   inadmissible     → return outcome 'rejected'  (runtime NOT called)
 *
 * The runtime call happens exactly once on the admissible path
 * and zero times on every other path — including verification
 * failure. The conversation runtime is fully responsible for the
 * single-shot model invocation; the actor adds no retry, no
 * fallback, no second-pass behavior.
 *
 * The actor does NOT:
 *   - log the response text or memoryCount (only the metadata
 *     outcome shape).
 *   - persist anything (no new EVENT_TYPES; the conversation
 *     chain already emits memory.list on the admissible path).
 *   - construct a Decision (impossible — the constructor is
 *     opaque per GM-21).
 *   - re-classify or re-attempt a non-admissible Decision.
 */

const {
  Decision,
  isValidDecision,
  REASONS,
  DECISION_OUTCOMES,
  INTENT_TYPES,
} = require('../governance');
const { OUTCOMES } = require('./outcomes');

// Build the validation sets from the public vocabularies. The
// governance module's ALL_* internal collections are not part of
// its public surface; this keeps the actor's import list aligned
// with what src/governance/index.js exports.
const VALID_REASONS = new Set(Object.values(REASONS));
const VALID_OUTCOMES = new Set(Object.values(DECISION_OUTCOMES));

function isConversationRuntime(runtime) {
  return (
    runtime
    && typeof runtime === 'object'
    && typeof runtime.respond === 'function'
  );
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'response-delivery actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'response-delivery actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('response-delivery actor: decision must be frozen');
  }
  // Layer 4: intent-type confusion check — the response-delivery
  // actor accepts ONLY response.deliver Decisions.
  if (decision.intentType !== INTENT_TYPES.RESPONSE_DELIVER) {
    throw new Error(
      `response-delivery actor: intentType must be ${INTENT_TYPES.RESPONSE_DELIVER} `
        + `(got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  // The Decision constructor already validates these, but we
  // re-check defensively in case a future refactor weakens the
  // constructor.
  if (!VALID_OUTCOMES.has(decision.decision)) {
    throw new Error('response-delivery actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('response-delivery actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('response-delivery actor: decision.policyRef must be a non-empty string');
  }
}

function validateParams(params) {
  // The actor relays params to conversationRuntime.respond unchanged;
  // the runtime owns full parameter validation (UUIDs, role token,
  // userMessage length cap, memoryLimit shape). The actor asserts
  // only that params is a non-null object so a programmer error
  // here surfaces synchronously.
  if (!params || typeof params !== 'object') {
    throw new Error('response-delivery actor: params object is required');
  }
}

function createResponseDeliveryActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createResponseDeliveryActor: options object is required');
  }
  const { conversationRuntime, log } = options;
  if (!isConversationRuntime(conversationRuntime)) {
    throw new Error(
      'createResponseDeliveryActor: conversationRuntime must expose respond()'
    );
  }
  const logger = log && typeof log.info === 'function' ? log : null;

  async function execute(decision, params) {
    // Verification first — throws on forged / tampered / mismatched
    // Decisions. The runtime is not consulted on any failure path.
    verifyDecisionOrThrow(decision);
    validateParams(params);

    // Classification routing.
    if (decision.decision === DECISION_OUTCOMES.INADMISSIBLE) {
      if (logger) {
        logger.info('actor.response_delivery.rejected', {
          intent_type: decision.intentType,
          decision: decision.decision,
          reason: decision.reason,
        });
      }
      return Object.freeze({
        outcome: OUTCOMES.REJECTED,
        decision,
      });
    }

    if (decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW) {
      if (logger) {
        logger.info('actor.response_delivery.abstained', {
          intent_type: decision.intentType,
          decision: decision.decision,
          reason: decision.reason,
        });
      }
      return Object.freeze({
        outcome: OUTCOMES.ABSTAINED,
        decision,
      });
    }

    // decision.decision === DECISION_OUTCOMES.ADMISSIBLE — exhausted.
    // The single conversation runtime call happens here. The
    // runtime owns its own single-shot, non-streaming, no-tool-
    // calling discipline; the actor adds no retry, no second pass.
    const result = await conversationRuntime.respond(params);

    if (logger) {
      // Metadata only — never response text, never user message.
      logger.info('actor.response_delivery.executed', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        memory_count: result && typeof result.memoryCount === 'number' ? result.memoryCount : null,
        response_chars:
          result && typeof result.response === 'string' ? result.response.length : null,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.EXECUTED,
      decision,
      response: result && typeof result.response === 'string' ? result.response : '',
      memoryCount: result && typeof result.memoryCount === 'number' ? result.memoryCount : 0,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createResponseDeliveryActor, OUTCOMES };
