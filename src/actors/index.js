'use strict';
/*
 * Actors public API — GM-22 + GM-23.
 *
 * Decision-gated executors. Every actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid + actor-
 *      specific outcome check).
 *   2. On admissible → execute (response-delivery actor).
 *   3. On requires_review → durably stage to the review queue
 *      (GM-23 review-queue actor).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw (programmer
 *      error).
 *
 * Two actors today:
 *   - createResponseDeliveryActor (GM-22) — wraps the conversation
 *     runtime; admits ONLY decision.intentType === response.deliver.
 *   - createReviewQueueActor (GM-23) — stages requires_review
 *     Decisions into governance_review_queue; admits ANY intent
 *     type as long as decision.decision === requires_review.
 *
 * Each actor has its own intent-type contract and its own outcome
 * routing. They share the OUTCOMES vocabulary (executed / abstained
 * / rejected / staged).
 */

const { createResponseDeliveryActor } = require('./response-delivery-actor');
const { createReviewQueueActor } = require('./review-queue-actor');
const { OUTCOMES } = require('./outcomes');

module.exports = {
  createResponseDeliveryActor,
  createReviewQueueActor,
  OUTCOMES,
};
