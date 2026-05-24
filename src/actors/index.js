'use strict';
/*
 * Actors public API — GM-22 + GM-23 + GM-24.
 *
 * Decision-gated executors. Every actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid + actor-
 *      specific outcome / role check).
 *   2. On admissible → execute (response-delivery actor).
 *   3. On requires_review → durably stage to the review queue
 *      (GM-23 review-queue actor).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw (programmer
 *      error).
 *
 * Three actors today:
 *   - createResponseDeliveryActor (GM-22) — wraps the conversation
 *     runtime; admits ONLY decision.intentType === response.deliver.
 *   - createReviewQueueActor (GM-23) — stages requires_review
 *     Decisions into governance_review_queue; admits ANY intent
 *     type as long as decision.decision === requires_review.
 *   - createReviewDecisionActor (GM-24) — records a human admin's
 *     review outcome ('approved' | 'rejected') against a pending
 *     queue item, into governance_review_decisions; admits ONLY
 *     decision.intentType === governance.review.decide AND
 *     params.userRole === 'admin'. Approval is NOT authorization;
 *     recording is NOT execution.
 *
 * Each actor has its own intent-type contract and its own outcome
 * routing. They share the OUTCOMES vocabulary (executed / abstained
 * / rejected / staged / recorded).
 */

const { createResponseDeliveryActor } = require('./response-delivery-actor');
const { createReviewQueueActor } = require('./review-queue-actor');
const { createReviewDecisionActor } = require('./review-decision-actor');
const { OUTCOMES } = require('./outcomes');

module.exports = {
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  OUTCOMES,
};
