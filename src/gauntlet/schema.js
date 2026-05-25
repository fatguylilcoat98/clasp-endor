'use strict';
/*
 * Scenario + result schema for the GM-30 adversarial gauntlet.
 *
 * Locked vocabularies. Adding a value requires paired updates
 * to this file, the L37 snapshot in
 * tests/governance/adversarial.test.js, and the runner's
 * dispatch logic. The scenario schema version is locked at the
 * literal "1.0.0" string for GM-30 (per OQ-30.17); bumping it
 * requires a new decision gate.
 *
 * Constitutional note: the result schema deliberately excludes
 * payload / evidence content. The L14 sentinel-scan canary plants
 * known content in a scenario's setup ops and asserts it never
 * appears in the rendered result. Any future field added here
 * that would echo arbitrary user-controlled content into the
 * result is a process failure — fix the field, not the test.
 */

const SCENARIO_SCHEMA_VERSION = '1.0.0';

// Twelve mutually-exclusive categories of adversarial probe.
// L37 snapshot enforces.
const SCENARIO_CATEGORIES = Object.freeze([
  'forged-decision',
  'wrong-intent',
  'wrong-role',
  'vocabulary-drift',
  'replay-violation',
  'cross-pilot-isolation',
  'chain-walk-corruption',
  'separation-of-duties-violation',
  'consumer-reference-violation',
  'forbidden-vocabulary-drift',
  'doc-presence-violation',
  'event-types-widening',
]);

// What kind of step the scenario asks the harness to run. Each
// kind maps to a single named dispatch path in harness.js.
// L37 snapshot enforces.
const STEP_KINDS = Object.freeze([
  'actor-call',
  'classifier-call',
  'static-scan',
  'boundary-guard',
  'snapshot-check',
  'forged-decision',
]);

// Allowed actor factory names. Identical to the eight Decision-
// gated actors exported from src/actors/index.js. L22 substrate-
// freeze canary enforces this list never grows or shrinks in
// GM-30.
const ACTOR_NAMES = Object.freeze([
  'createResponseDeliveryActor',
  'createReviewQueueActor',
  'createReviewDecisionActor',
  'createExecutionAuthorizationActor',
  'createExecutionClaimLedgerActor',
  'createExecutionAttemptLedgerActor',
  'createExecutionOutcomeLedgerActor',
  'createExecutionVerificationLedgerActor',
]);

// Setup operation vocabulary. Each value names a single helper
// in fixtures.js. No raw SQL, no ad-hoc inserts — every setup
// step goes through a named, reviewed helper.
const SETUP_OPS = Object.freeze([
  'fixtures.reset',
  'chain.through.queue',
  'chain.through.decision',
  'chain.through.authorization',
  'chain.through.claim',
  'chain.through.attempt',
  'chain.through.outcome',
]);

// What pattern of forged-Decision to construct, when
// step.kind === 'forged-decision'. The point of testing each
// pattern is that the actor's WeakSet / instanceof / freeze /
// intent-type / structural-revalidation chain catches it.
const FORGERY_PATTERNS = Object.freeze([
  'plain-object',
  'prototype-tamper',
  'wrong-intent',
  'missing-field',
  'mutated-after-freeze',
]);

// What the scenario expects to happen.
const EXPECT_RESULTS = Object.freeze([
  'expected_admission',
  'expected_rejection',
  'expected_throw',
  'expected_no_op',
]);

// Which architectural layer the rejection / throw is expected
// to land at. The harness records the actual layer hit so the
// council can detect drift (e.g. a probe that USED to fail at
// the actor now fails at the trigger — substrate has shifted).
const LAYERS = Object.freeze([
  'classifier',
  'actor-layer-1',
  'actor-layer-2',
  'actor-layer-3',
  'actor-layer-4',
  'actor-layer-5',
  'actor-layer-6',
  'actor-layer-7',
  'actor-layer-8',
  'actor-layer-9',
  'db-trigger',
  'db-check',
  'db-unique',
  'rls',
  'grant',
  'static-scan',
  'boundary-guard',
  'snapshot',
  // GM-30 harness-corrective patch: when the actor wraps a
  // DB-side rejection into ReviewRepositoryError, the
  // sanitization layer in src/review/transaction.js
  // intentionally discards the original error class, so the
  // harness cannot disambiguate UNIQUE vs CHECK vs trigger vs
  // RLS WITH CHECK vs GRANT denial after the fact. Per the
  // OQ-30 harness-only corrective directive, db-rejection is
  // the conservative bucket for "the substrate refused at the
  // DB layer, exact sub-layer not recoverable." Probes that
  // need the exact sub-layer should issue raw SQL through
  // tests/integration/*.test.js where the original error
  // class is still visible (per OQ-30.6(b)).
  'db-rejection',
]);

// Council-facing failure classifications. Per constitutional
// addendum 9 + OQ-30.13. The result.council.classification
// field accepts exactly these values OR null.
const COUNCIL_CLASSIFICATIONS = Object.freeze([
  'expected_rejection',
  'expected_admission',
  'test_bug',
  'fixture_bug',
  'substrate_bug',
  'invariant_violation',
  'missing_architecture',
  'classified_pending',
  'no_action_needed',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Structural scenario validator. Throws on any malformed input.
// The runner calls this BEFORE any DB action; a malformed
// scenario never reaches the harness's dispatch layer.
function validateScenario(s) {
  if (!isPlainObject(s)) {
    throw new Error('scenario: must be an object');
  }
  if (typeof s.id !== 'string' || s.id.length === 0) {
    throw new Error('scenario.id: must be a non-empty string');
  }
  if (typeof s.version !== 'string' || s.version !== SCENARIO_SCHEMA_VERSION) {
    throw new Error(
      `scenario.version: must equal "${SCENARIO_SCHEMA_VERSION}" (got "${s.version}")`
    );
  }
  if (!SCENARIO_CATEGORIES.includes(s.category)) {
    throw new Error(
      `scenario.category: must be one of ${SCENARIO_CATEGORIES.join(', ')} (got "${s.category}")`
    );
  }
  if (typeof s.description !== 'string') {
    throw new Error('scenario.description: must be a string');
  }
  if (!isPlainObject(s.session)) {
    throw new Error('scenario.session: must be an object');
  }
  const { pilotInstanceId, userId, userRole } = s.session;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('scenario.session.pilotInstanceId: must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('scenario.session.userId: must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(`scenario.session.userRole: must be one of ${Array.from(VALID_ROLES).join(', ')}`);
  }
  if (!Array.isArray(s.setup)) {
    throw new Error('scenario.setup: must be an array');
  }
  for (let i = 0; i < s.setup.length; i += 1) {
    const op = s.setup[i];
    if (!isPlainObject(op) || typeof op.op !== 'string') {
      throw new Error(`scenario.setup[${i}]: must be an object with a string "op" field`);
    }
    if (!SETUP_OPS.includes(op.op)) {
      throw new Error(
        `scenario.setup[${i}].op: must be one of ${SETUP_OPS.join(', ')} (got "${op.op}")`
      );
    }
  }
  if (!isPlainObject(s.step)) {
    throw new Error('scenario.step: must be an object');
  }
  if (!STEP_KINDS.includes(s.step.kind)) {
    throw new Error(
      `scenario.step.kind: must be one of ${STEP_KINDS.join(', ')} (got "${s.step.kind}")`
    );
  }
  if (s.step.kind === 'actor-call') {
    if (!ACTOR_NAMES.includes(s.step.actor)) {
      throw new Error(
        `scenario.step.actor: must be one of ${ACTOR_NAMES.join(', ')} (got "${s.step.actor}")`
      );
    }
    if (typeof s.step.intent !== 'string') {
      throw new Error('scenario.step.intent: must be a string when kind=actor-call');
    }
    if (!isPlainObject(s.step.params)) {
      throw new Error('scenario.step.params: must be an object when kind=actor-call');
    }
  }
  if (s.step.kind === 'forged-decision') {
    if (!FORGERY_PATTERNS.includes(s.step.forgery)) {
      throw new Error(
        `scenario.step.forgery: must be one of ${FORGERY_PATTERNS.join(', ')} (got "${s.step.forgery}")`
      );
    }
    if (!ACTOR_NAMES.includes(s.step.actor)) {
      throw new Error('scenario.step.actor: must be a valid actor name when kind=forged-decision');
    }
  }
  if (s.step.kind === 'static-scan' || s.step.kind === 'boundary-guard' || s.step.kind === 'snapshot-check') {
    if (typeof s.step.scan !== 'string') {
      throw new Error(`scenario.step.scan: must be a string when kind=${s.step.kind}`);
    }
  }
  if (!isPlainObject(s.expect)) {
    throw new Error('scenario.expect: must be an object');
  }
  if (!EXPECT_RESULTS.includes(s.expect.result)) {
    throw new Error(
      `scenario.expect.result: must be one of ${EXPECT_RESULTS.join(', ')} (got "${s.expect.result}")`
    );
  }
  if (s.expect.layerHit !== null && !LAYERS.includes(s.expect.layerHit)) {
    throw new Error(
      `scenario.expect.layerHit: must be one of ${LAYERS.join(', ')} or null (got "${s.expect.layerHit}")`
    );
  }
  if (s.expect.errorClassMatches !== null && typeof s.expect.errorClassMatches !== 'string') {
    throw new Error('scenario.expect.errorClassMatches: must be a string regex or null');
  }
  return true;
}

module.exports = {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_CATEGORIES,
  STEP_KINDS,
  ACTOR_NAMES,
  SETUP_OPS,
  FORGERY_PATTERNS,
  EXPECT_RESULTS,
  LAYERS,
  COUNCIL_CLASSIFICATIONS,
  validateScenario,
};
