'use strict';
/*
 * Review-queue actor — GM-23.
 *
 * The second Decision-gated actor. Stages requires_review Decisions
 * into the GM-23 governance_review_queue substrate for later human
 * review.
 *
 * The actor inherits the GM-22 five-layer Decision verification
 * (instanceof Decision + isValidDecision WeakSet check + frozen +
 * structural revalidation + intent-type) and adds a SIXTH layer
 * specific to this actor:
 *
 *   6. decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW
 *
 * Failure paths:
 *   - Forged / tampered / mutated Decision → THROW (programmer
 *     error; per GM-22 pattern).
 *   - Decision with `admissible` or `inadmissible` outcome → THROW
 *     (review-queue rejects — these don't belong in the queue).
 *   - Verified valid requires_review Decision → INSERT one row into
 *     governance_review_queue via withReviewContext → return
 *     {outcome: 'staged', decision, queueEntryId, createdAt}.
 *
 * The actor's intent-type check accepts ANY value from INTENT_TYPES
 * — unlike the response-delivery actor which is locked to
 * response.deliver. Any intent type can in principle be classified
 * requires_review, and the queue stages all of them.
 *
 * What the actor does NOT do:
 *   - Log payload_summary or evidence_summary (only typed metadata).
 *   - Perform any other DB op (no SELECT, no UPDATE, no DELETE).
 *   - Read the queue (no read API in GM-23 per OQ-23.11).
 *   - Notify external systems.
 *   - Auto-action, auto-admit, auto-promote.
 *   - Open or revoke vault sessions.
 *   - Mutate memory.
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
const VALID_INTENT_TYPES = new Set(Object.values(INTENT_TYPES));
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);
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
      'review-queue actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'review-queue actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('review-queue actor: decision must be frozen');
  }
  // Layer 4: intent-type — the review-queue actor accepts ANY value
  // in INTENT_TYPES (unlike the response-delivery actor's
  // single-intent lock). Reject unknown values explicitly.
  if (!VALID_INTENT_TYPES.has(decision.intentType)) {
    throw new Error(
      `review-queue actor: decision.intentType "${decision.intentType}" is not a known INTENT_TYPES value`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_OUTCOMES.has(decision.decision)) {
    throw new Error('review-queue actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('review-queue actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('review-queue actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (NEW for GM-23): the review queue stages requires_review
  // Decisions ONLY. Admissible and inadmissible Decisions must not
  // be staged — admissible ones belong with the response-delivery
  // actor (or its future siblings); inadmissible ones get recorded
  // and dropped by their caller.
  if (decision.decision !== DECISION_OUTCOMES.REQUIRES_REVIEW) {
    throw new Error(
      `review-queue actor: only requires_review Decisions can be staged (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('review-queue actor: params object is required');
  }
  const { pilotInstanceId, userId, userRole } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('review-queue actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('review-queue actor: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `review-queue actor: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
}

function createReviewQueueActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createReviewQueueActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createReviewQueueActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
    );
  }
  const logger = log && typeof log.info === 'function' ? log : null;

  async function execute(decision, params) {
    // Verification first — throws on forged / tampered / wrong-outcome
    // Decisions. The review pool is not consulted on any failure path.
    verifyDecisionOrThrow(decision);
    validateParams(params);

    const { pilotInstanceId, userId, userRole, payloadSummary, evidenceSummary } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.stageReviewItem({
          decisionIntentType: decision.intentType,
          decisionReason: decision.reason,
          decisionPolicyRef: decision.policyRef,
          proposerRole: userRole,
          payloadSummary,
          evidenceSummary,
        })
    );

    if (logger) {
      // Metadata only — never payload_summary, evidence_summary, or
      // any other content. The sentinel-scan adversarial test (E6)
      // asserts planted secrets in payload/evidence do not appear
      // in captured log lines.
      logger.info('actor.review_queue.staged', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        queue_entry_id: inserted.id,
        proposer_user_id: userId,
        actor_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.STAGED,
      decision,
      queueEntryId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createReviewQueueActor };
