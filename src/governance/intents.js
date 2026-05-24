'use strict';
/*
 * Locked intent-type taxonomy — GM-21.
 *
 * Every intent the governance classifier knows about is listed here.
 * Adding a new intent type requires:
 *   1. Adding a constant to INTENT_TYPES below.
 *   2. Adding a corresponding REASONS entry in ./decisions.js.
 *   3. Adding a classifier branch in ./classifier.js.
 *   4. Adding a paired update to
 *      docs/governance/governance-runtime-boundary.md.
 *   5. Adding a paired update to
 *      docs/governance/source-of-truth-memory-policy.md when the new
 *      intent type touches memory or vault behavior.
 *
 * Default-deny rule: any intent.type not in INTENT_TYPES is
 * classified inadmissible with reason `unknown_intent_type`.
 *
 * The taxonomy is intentionally closed — there is no `OTHER` or
 * `CUSTOM` intent type. Every conceivable action must be named and
 * classified.
 */

const INTENT_TYPES = Object.freeze({
  // Returning a model response to the caller. The most basic
  // permitted operation. The GM-20 conversation runtime already does
  // this; classifying it as an intent makes the act governance-typed
  // and gives a future actor module a stable contract.
  RESPONSE_DELIVER: 'response.deliver',

  // Proposing a new memory based on model output. The payload's
  // `provenance` field drives sub-classification. AI_INFERRED and
  // USER_STATED both default to `requires_review` (no auto-admit);
  // VERIFIED_FACT is inadmissible because §3 of the memory policy
  // forbids model self-promotion.
  MEMORY_CANDIDATE_CREATE: 'memory.candidate.create',

  // Changing a memory's visibility level (private ↔ family_shared,
  // either direction). Inadmissible in GM-21 because §12 requires an
  // explicit authority-validated action that does not yet exist.
  MEMORY_VISIBILITY_PROMOTE: 'memory.visibility.promote',

  // Marking a memory inadmissible. Inadmissible in GM-21 — the §6
  // retraction workflow does not yet exist.
  MEMORY_RETRACT: 'memory.retract',

  // Creating a new memory that supersedes an existing one.
  // Inadmissible in GM-21 — the §7 supersession workflow does not yet
  // exist.
  MEMORY_SUPERSEDE: 'memory.supersede',

  // Opening a vault session (after PIN verification). Inadmissible in
  // GM-21 — the §13 vault infrastructure (PIN verify, INSERT WITH
  // CHECK policy on memory_vault_sessions, failed-attempt accounting)
  // does not yet exist.
  VAULT_SESSION_OPEN: 'vault.session.open',

  // Revoking an open vault session. Inadmissible in GM-21 — paired
  // with the open op above; no vault infrastructure.
  VAULT_SESSION_REVOKE: 'vault.session.revoke',

  // Catch-all for any side effect outside the governed memory
  // surface (sending a message, calling an external API, writing to
  // disk, etc.). Inadmissible in GM-21 — there is no external-side-
  // effect capability anywhere in the codebase, and the default-deny
  // rule keeps it that way.
  EXTERNAL_SIDE_EFFECT: 'external.side_effect',

  // GM-24: recording a human admin's review outcome against a
  // pending review_queue item. Classifier returns `admissible` —
  // role enforcement (admin only) lives at the review-decision
  // actor (src/actors/review-decision-actor.js), not here. The
  // classifier is stateless and has no session context.
  GOVERNANCE_REVIEW_DECIDE: 'governance.review.decide',
});

const ALL_INTENT_TYPES = new Set(Object.values(INTENT_TYPES));

// Provenance classes (mirrors src/memory/repository.js VALID_PROVENANCE
// and §1 of source-of-truth-memory-policy.md). Defined locally per
// OQ-21.8 — the governance module is a leaf with no cross-layer
// imports. Change-control rule: edits to either copy require paired
// edits to the other.
const PROVENANCE_CLASSES = Object.freeze({
  VERIFIED_FACT: 'VERIFIED_FACT',
  USER_STATED: 'USER_STATED',
  AI_INFERRED: 'AI_INFERRED',
});

const ALL_PROVENANCE_CLASSES = new Set(Object.values(PROVENANCE_CLASSES));

module.exports = {
  INTENT_TYPES,
  ALL_INTENT_TYPES,
  PROVENANCE_CLASSES,
  ALL_PROVENANCE_CLASSES,
};
