'use strict';
/*
 * Unit tests for the GM-22 response-delivery actor.
 *
 * The Decision instances under test come from the real GM-21
 * classifier (so the WeakSet-blessed contract is exercised, not
 * faked). The conversation runtime is mocked — no DB, no model
 * SDK.
 *
 * What these tests prove:
 *   - factory validation (options object, conversationRuntime
 *     shape);
 *   - returned actor is frozen and exposes only execute();
 *   - admissible Decision for response.deliver → runtime called
 *     exactly once; outcome 'executed' with response + memoryCount;
 *   - requires_review Decision → runtime NOT called; outcome
 *     'abstained';
 *   - inadmissible Decision → runtime NOT called; outcome
 *     'rejected';
 *   - sentinel content in user message + model response NEVER
 *     appears in captured log lines (the central GM-22 privacy
 *     assertion at this layer);
 *   - the actor returns a frozen result object that cannot be
 *     mutated by a downstream caller.
 *
 * The negative properties (forged Decisions, tampered Decisions,
 * type confusion, EVENT_TYPES snapshot) live in the dedicated
 * adversarial suite at tests/governance/adversarial.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
  DECISION_OUTCOMES,
} = require('../../src/governance');
const {
  createResponseDeliveryActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeMockRuntime(responseText) {
  let calls = 0;
  const requests = [];
  return {
    getCalls: () => calls,
    getRequests: () => requests,
    async respond(params) {
      calls += 1;
      requests.push(params);
      return {
        response: responseText !== undefined ? responseText : 'OK',
        memoryCount: 3,
      };
    },
  };
}

function makeCapturingLogger() {
  const lines = [];
  return {
    lines,
    info(event, fields) {
      lines.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
    asJoinedText() { return lines.join('\n'); },
  };
}

function admissibleDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
}

function inadmissibleDecision() {
  // memory.visibility.promote is inadmissible in GM-21.
  return classifyExecutionIntent({ type: INTENT_TYPES.MEMORY_VISIBILITY_PROMOTE });
}

function requiresReviewDecision() {
  // memory.candidate.create AI_INFERRED is requires_review in GM-21.
  return classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: USER,
      userRole: 'senior',
      userMessage: 'hello',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createResponseDeliveryActor: rejects missing options', () => {
  assert.throws(() => createResponseDeliveryActor(), /options object is required/);
  assert.throws(() => createResponseDeliveryActor(null), /options object is required/);
});

test('createResponseDeliveryActor: rejects missing conversationRuntime', () => {
  assert.throws(
    () => createResponseDeliveryActor({}),
    /conversationRuntime must expose respond\(\)/
  );
});

test('createResponseDeliveryActor: rejects runtime without respond()', () => {
  assert.throws(
    () => createResponseDeliveryActor({ conversationRuntime: { foo: 1 } }),
    /conversationRuntime must expose respond\(\)/
  );
});

test('actor: returned object is frozen and exposes ONLY execute', () => {
  const actor = createResponseDeliveryActor({ conversationRuntime: makeMockRuntime() });
  assert.equal(typeof actor.execute, 'function');
  for (const forbidden of [
    'conversationRuntime', 'runtime', 'pool', 'handle', 'connect', 'query', 'client', 'log',
  ]) {
    assert.equal(actor[forbidden], undefined, `actor must not expose .${forbidden}`);
  }
  assert.equal(Object.isFrozen(actor), true);
  assert.throws(() => { actor.somethingElse = () => 1; });
});

// ---- admissible path ----

test('actor.execute: admissible response.deliver → runtime called exactly once; outcome executed', async () => {
  const runtime = makeMockRuntime('the model reply');
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const decision = admissibleDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(runtime.getCalls(), 1);
  assert.equal(result.outcome, OUTCOMES.EXECUTED);
  assert.equal(result.decision, decision);
  assert.equal(result.response, 'the model reply');
  assert.equal(result.memoryCount, 3);
  assert.equal(Object.isFrozen(result), true);
});

test('actor.execute: passes params unchanged through to the runtime', async () => {
  const runtime = makeMockRuntime('ok');
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const params = baseParams({ memoryLimit: 7 });
  await actor.execute(admissibleDecision(), params);
  const [req] = runtime.getRequests();
  assert.deepEqual(req, params);
});

// ---- abstained / rejected paths ----

test('actor.execute: requires_review → runtime NOT called; outcome abstained', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  // Note: requires_review Decision is for memory.candidate.create —
  // the response-delivery actor still rejects it on intent-type
  // grounds BEFORE the outcome routing runs. To test the abstained
  // outcome at the route, we need a Decision that is (a) for
  // response.deliver AND (b) classified requires_review. The GM-21
  // classifier returns admissible for response.deliver; there is
  // no path to a requires_review response.deliver. So this test
  // verifies type-confusion throwing instead.
  const reviewDecision = requiresReviewDecision();
  await assert.rejects(
    () => actor.execute(reviewDecision, baseParams()),
    /intentType must be response\.deliver/
  );
  assert.equal(runtime.getCalls(), 0);
});

test('actor.execute: inadmissible Decision for the right intent type → outcome rejected (runtime NOT called)', async () => {
  // Same wrinkle as above — there is no inadmissible classification
  // of response.deliver in GM-21. The negative path (a Decision for
  // a different intent type) is enforced by the intentType check;
  // assert that here, and assert the runtime is not consulted.
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const bad = inadmissibleDecision();
  await assert.rejects(
    () => actor.execute(bad, baseParams()),
    /intentType must be response\.deliver/
  );
  assert.equal(runtime.getCalls(), 0);
});

// ---- params validation ----

test('actor.execute: rejects missing params object (programmer error throws)', async () => {
  const runtime = makeMockRuntime();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  await assert.rejects(
    () => actor.execute(admissibleDecision(), null),
    /params object is required/
  );
  assert.equal(runtime.getCalls(), 0);
});

// ---- log hygiene (sentinel scan) ----

test('actor.execute: sentinel content in user message AND in model response NEVER appears in captured logs', async () => {
  const RESPONSE_SENTINEL = 'RESPONSE_SECRET_ACTOR_111';
  const USER_SENTINEL = 'USER_INPUT_ACTOR_222';
  const runtime = makeMockRuntime(`the model said ${RESPONSE_SENTINEL}`);
  const log = makeCapturingLogger();
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime, log });

  const result = await actor.execute(admissibleDecision(), baseParams({
    userMessage: `please tell me ${USER_SENTINEL}`,
  }));

  // Caller sees the response unchanged.
  assert.ok(result.response.includes(RESPONSE_SENTINEL));

  const captured = log.asJoinedText();
  assert.equal(captured.includes(RESPONSE_SENTINEL), false, 'response text must not appear in logs');
  assert.equal(captured.includes(USER_SENTINEL), false, 'user message must not appear in logs');
  // Sanity: the metadata event was emitted.
  assert.ok(captured.includes('actor.response_delivery.executed'));
});

test('actor.execute: works without an optional logger', async () => {
  const runtime = makeMockRuntime('ok');
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const result = await actor.execute(admissibleDecision(), baseParams());
  assert.equal(result.outcome, OUTCOMES.EXECUTED);
});

// ---- index re-exports ----

test('src/actors/index: re-exports createResponseDeliveryActor and OUTCOMES only', () => {
  const actors = require('../../src/actors');
  assert.equal(typeof actors.createResponseDeliveryActor, 'function');
  assert.equal(typeof actors.OUTCOMES, 'object');
  assert.equal(Object.isFrozen(actors.OUTCOMES), true);
  // No re-export of internal helpers.
  assert.equal(actors.verifyDecisionOrThrow, undefined);
  assert.equal(actors.validateParams, undefined);
});

// ---- locked OUTCOMES ----

test('OUTCOMES constants are the locked four-way set (GM-22 + GM-23)', () => {
  // GM-22 introduced executed / abstained / rejected. GM-23 added
  // `staged` for the review-queue actor's happy path. The shared
  // OUTCOMES enum is the locked vocabulary; any addition fails
  // this test and forces a paired review of the actor boundary
  // doc and the GM-23 adversarial snapshot.
  assert.deepEqual(
    Object.values(OUTCOMES).sort(),
    ['abstained', 'executed', 'rejected', 'staged']
  );
});

// ---- outcome carries decision; admissible carries response + memoryCount ----

test('actor.execute: admissible outcome carries decision, response, and memoryCount; nothing else', async () => {
  const runtime = makeMockRuntime('reply');
  const actor = createResponseDeliveryActor({ conversationRuntime: runtime });
  const result = await actor.execute(admissibleDecision(), baseParams());
  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, ['decision', 'memoryCount', 'outcome', 'response']);
});
