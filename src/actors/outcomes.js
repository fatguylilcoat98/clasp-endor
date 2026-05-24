'use strict';
/*
 * Shared OUTCOMES vocabulary for every actor.
 *
 * Locked enum. Adding a new outcome requires paired updates to
 * docs/governance/actor-runtime-boundary.md and the relevant
 * adversarial test snapshots.
 *
 *   EXECUTED  — admissible Decision was acted on (response-delivery
 *               actor: the conversation runtime was called and a
 *               response was produced).
 *   ABSTAINED — requires_review Decision was NOT acted on. The
 *               response-delivery actor returns this when handed a
 *               requires_review Decision (defense in depth — the
 *               GM-21 classifier doesn't actually return
 *               requires_review for response.deliver, but the
 *               outcome shape is well-defined).
 *   REJECTED  — inadmissible Decision was NOT acted on, OR a
 *               verification check failed before routing.
 *   STAGED    — GM-23: requires_review Decision was durably
 *               staged into governance_review_queue for later
 *               human review. The review-queue actor returns
 *               this outcome on the happy path.
 *   RECORDED  — GM-24: a human admin's review outcome was
 *               durably recorded into governance_review_decisions.
 *               The review-decision actor returns this outcome
 *               on the happy path. This is the act of *recording*
 *               a review outcome — it is NOT authorization, NOT
 *               execution, and NOT a signal to act. Future
 *               execution gates must be separately approved.
 */

const OUTCOMES = Object.freeze({
  EXECUTED:  'executed',
  ABSTAINED: 'abstained',
  REJECTED:  'rejected',
  STAGED:    'staged',
  RECORDED:  'recorded',
});

module.exports = { OUTCOMES };
