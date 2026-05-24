'use strict';
/*
 * Review-queue repository — one operation, stageReviewItem.
 *
 * GM-23 ships this single function. The function is invoked through
 * the ctx the caller receives from withReviewContext; the raw pg
 * client is intentionally NOT exposed.
 *
 * Hard rules:
 *   - Single INSERT into governance_review_queue. No SELECT, no
 *     UPDATE, no DELETE (the table is append-only and the module
 *     has no grants for the mutation operations anyway).
 *   - The status column is set to its default ('pending_review') at
 *     the DB layer; the repository does not name it. A future GM
 *     that adds status transitions will need its own surface.
 *   - The function does NOT validate the Decision shape — the
 *     review-queue actor (src/actors/review-queue-actor.js) is
 *     responsible for the six-layer verification. This module is
 *     the persistence layer; the actor is the gate.
 *   - Required input fields: decisionIntentType, decisionReason,
 *     decisionPolicyRef, proposerRole, payloadSummary?,
 *     evidenceSummary?. proposerUserId and pilotInstanceId come
 *     from the session context (NOT from input) so the RLS WITH
 *     CHECK policy can enforce no-impersonation.
 *   - payload_summary and evidence_summary are passed through
 *     unchanged as JSONB. Caller decides what to serialize; the
 *     module does not inspect or log either field.
 *   - The function returns { id, created_at } — the new queue
 *     entry's row identifier and timestamp. Nothing else; the
 *     caller already has the Decision metadata it supplied.
 */

const VALID_DECISION_INTENT_TYPES = new Set([
  'response.deliver',
  'memory.candidate.create',
  'memory.visibility.promote',
  'memory.retract',
  'memory.supersede',
  'vault.session.open',
  'vault.session.revoke',
  'external.side_effect',
]);

const VALID_DECISION_REASONS = new Set([
  'response_delivery_permitted',
  'ai_inferred_requires_review',
  'user_stated_requires_review',
  'verified_fact_self_promotion_forbidden',
  'visibility_promotion_requires_authority',
  'retraction_infrastructure_not_available',
  'supersession_infrastructure_not_available',
  'vault_infrastructure_not_available',
  'external_side_effects_not_authorized',
  'unknown_intent_type',
  'malformed_intent_payload',
]);

const VALID_PROPOSER_ROLES = new Set([
  'senior', 'family', 'caregiver', 'admin', 'system',
]);

async function stageReviewItem(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('stageReviewItem: input is required');
  }
  const {
    decisionIntentType,
    decisionReason,
    decisionPolicyRef,
    proposerRole,
    payloadSummary,
    evidenceSummary,
  } = input;

  if (!VALID_DECISION_INTENT_TYPES.has(decisionIntentType)) {
    throw new Error(
      `stageReviewItem: decisionIntentType must be one of ${Array.from(VALID_DECISION_INTENT_TYPES).join(', ')}`
    );
  }
  if (!VALID_DECISION_REASONS.has(decisionReason)) {
    throw new Error(
      `stageReviewItem: decisionReason must be one of ${Array.from(VALID_DECISION_REASONS).join(', ')}`
    );
  }
  if (typeof decisionPolicyRef !== 'string' || decisionPolicyRef.length === 0) {
    throw new Error('stageReviewItem: decisionPolicyRef must be a non-empty string');
  }
  if (!VALID_PROPOSER_ROLES.has(proposerRole)) {
    throw new Error(
      `stageReviewItem: proposerRole must be one of ${Array.from(VALID_PROPOSER_ROLES).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO governance_review_queue '
      + '(pilot_instance_id, decision_intent_type, decision_reason, '
      + 'decision_policy_ref, proposer_user_id, proposer_role, '
      + 'payload_summary, evidence_summary) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) '
      + 'RETURNING id, created_at',
    [
      sessionCtx.pilotInstanceId,
      decisionIntentType,
      decisionReason,
      decisionPolicyRef,
      sessionCtx.userId,
      proposerRole,
      payloadSummary === undefined ? null : JSON.stringify(payloadSummary),
      evidenceSummary === undefined ? null : JSON.stringify(evidenceSummary),
    ]
  );

  return {
    id: inserted.rows[0].id,
    created_at: inserted.rows[0].created_at,
  };
}

module.exports = {
  stageReviewItem,
  VALID_DECISION_INTENT_TYPES,
  VALID_DECISION_REASONS,
  VALID_PROPOSER_ROLES,
};
