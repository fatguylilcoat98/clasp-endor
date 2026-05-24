'use strict';
/*
 * Review-decision actor — GM-24.
 *
 * The third Decision-gated actor. Records a human admin's review
 * outcome ('approved' | 'rejected') against a pending
 * governance_review_queue item, durably persisted into the new
 * GM-24 governance_review_decisions append-only substrate.
 *
 * The actor inherits the GM-22/GM-23 verification chain
 * (instanceof Decision + isValidDecision WeakSet + frozen +
 * structural revalidation + intent-type) and adds an actor-specific
 * SEVENTH layer:
 *
 *   7. params.userRole === 'admin'
 *
 * Failure paths:
 *   - Forged / tampered / mutated Decision → THROW (programmer
 *     error; per GM-22 pattern).
 *   - Decision with intentType !== governance.review.decide → THROW.
 *   - Decision outcome other than `admissible` → THROW (defense in
 *     depth — the classifier returns admissible for this intent
 *     type, but the outcome shape is well-defined).
 *   - userRole !== 'admin' → THROW BEFORE any DB call.
 *   - Verified valid admin review_decide Decision → INSERT one row
 *     into governance_review_decisions via withReviewContext →
 *     return {outcome: 'recorded', decision, reviewDecisionId,
 *     reviewedAt}.
 *
 * Critical invariant (constitutional):
 *
 *   Recording a review outcome is NOT execution.
 *   Approval is NOT authorization.
 *   Authorization is NOT execution.
 *
 * GM-24 records the outcome. No future actor in this module reads
 * recorded review_decision rows to do anything operational. Future
 * execution capability is a separately-gated decision.
 *
 * What the actor does NOT do:
 *   - Mutate the underlying queue row (it stays exactly as staged
 *     in GM-23).
 *   - Log review_outcome / review_reason content as anything other
 *     than typed metadata (the locked vocabularies are safe to log;
 *     a free-text reason field would not be — none exists in GM-24).
 *   - Perform any other DB op (no SELECT, no UPDATE, no DELETE).
 *   - Notify external systems.
 *   - Auto-execute the approved item.
 *   - Auto-promote memory.
 *   - Schedule background work.
 */

const {
  Decision,
  isValidDecision,
  REASONS,
  DECISION_OUTCOMES,
  INTENT_TYPES,
} = require('../governance');
const { withReviewContext } = require('../review');
const { OUTCOMES } = require('./outcomes');

const VALID_REASONS = new Set(Object.values(REASONS));
const VALID_OUTCOMES = new Set(Object.values(DECISION_OUTCOMES));
const VALID_REVIEW_OUTCOMES = new Set(['approved', 'rejected']);
const VALID_REVIEW_REASONS = new Set([
  'approved_admin_review',
  'rejected_insufficient_evidence',
  'rejected_policy_violation',
  'rejected_duplicate',
  'rejected_admin_review',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReviewQueuePool(handle) {
  // The review module exposes only the opaque ReviewPoolHandle.
  // Test mocks duck-type with a .connect function (which the
  // module's _resolvePool helper also accepts internally).
  return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'review-decision actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'review-decision actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('review-decision actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY governance.review.decide.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE) {
    throw new Error(
      `review-decision actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_OUTCOMES.has(decision.decision)) {
    throw new Error('review-decision actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('review-decision actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('review-decision actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible for
  // governance.review.decide. Defense in depth — refuse any other
  // outcome explicitly.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `review-decision actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('review-decision actor: params object is required');
  }
  const { pilotInstanceId, userId, userRole, reviewQueueId, reviewOutcome, reviewReason } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('review-decision actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('review-decision actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only. GM-24 admits no other
  // reviewer role. Widening requires a paired update to the actor,
  // the DB CHECK constraint, the RLS WITH CHECK, and the docs.
  if (userRole !== 'admin') {
    throw new Error(
      `review-decision actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof reviewQueueId !== 'string' || !UUID_RE.test(reviewQueueId)) {
    throw new Error('review-decision actor: reviewQueueId must be a UUID');
  }
  if (!VALID_REVIEW_OUTCOMES.has(reviewOutcome)) {
    throw new Error(
      `review-decision actor: reviewOutcome must be one of ${Array.from(VALID_REVIEW_OUTCOMES).join(', ')}`
    );
  }
  if (!VALID_REVIEW_REASONS.has(reviewReason)) {
    throw new Error(
      `review-decision actor: reviewReason must be one of ${Array.from(VALID_REVIEW_REASONS).join(', ')}`
    );
  }
}

function createReviewDecisionActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createReviewDecisionActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createReviewDecisionActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
    );
  }
  const logger = log && typeof log.info === 'function' ? log : null;

  async function execute(decision, params) {
    // Verification first — throws on forged / tampered / wrong-role
    // / vocabulary-invalid input. The pool is not consulted on any
    // failure path.
    verifyDecisionOrThrow(decision);
    validateParams(params);

    const {
      pilotInstanceId,
      userId,
      userRole,
      reviewQueueId,
      reviewOutcome,
      reviewReason,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordReviewDecision({
          reviewQueueId,
          reviewOutcome,
          reviewReason,
        })
    );

    if (logger) {
      // Metadata only — the review_outcome and review_reason are
      // locked vocabularies (safe to log); reviewer / queue ids
      // are typed identifiers. No payload, no evidence.
      logger.info('actor.review_decision.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        review_decision_id: inserted.id,
        review_queue_id: reviewQueueId,
        review_outcome: reviewOutcome,
        review_reason: reviewReason,
        reviewer_user_id: userId,
        reviewer_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.RECORDED,
      decision,
      reviewDecisionId: inserted.id,
      reviewedAt: inserted.reviewed_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createReviewDecisionActor };
