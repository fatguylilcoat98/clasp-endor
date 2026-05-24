'use strict';
/*
 * Unit tests for stageReviewItem — pure validation + the single
 * INSERT shape. No real DB; pg client is faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stageReviewItem } = require('../../src/review/repository');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const sessionCtx = { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' };

function makeFakeClient() {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params: params || [] });
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const validInput = {
  decisionIntentType: 'memory.candidate.create',
  decisionReason: 'ai_inferred_requires_review',
  decisionPolicyRef: 'source-of-truth-memory-policy.md §3, §5',
  proposerRole: 'senior',
  payloadSummary: { content: 'a proposed memory', provenance: 'AI_INFERRED' },
  evidenceSummary: { source: 'model_output' },
};

test('stageReviewItem: rejects missing input', async () => {
  await assert.rejects(() => stageReviewItem(makeFakeClient(), sessionCtx), /input is required/);
  await assert.rejects(() => stageReviewItem(makeFakeClient(), sessionCtx, null), /input is required/);
});

test('stageReviewItem: rejects unknown decisionIntentType', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => stageReviewItem(client, sessionCtx, { ...validInput, decisionIntentType: 'agent.run' }),
    /decisionIntentType must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('stageReviewItem: rejects unknown decisionReason', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => stageReviewItem(client, sessionCtx, { ...validInput, decisionReason: 'just_because' }),
    /decisionReason must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('stageReviewItem: rejects empty decisionPolicyRef', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => stageReviewItem(client, sessionCtx, { ...validInput, decisionPolicyRef: '' }),
    /decisionPolicyRef must be a non-empty string/
  );
});

test('stageReviewItem: rejects unknown proposerRole', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => stageReviewItem(client, sessionCtx, { ...validInput, proposerRole: 'overlord' }),
    /proposerRole must be one of/
  );
});

test('stageReviewItem: happy path issues exactly one INSERT with RETURNING', async () => {
  const client = makeFakeClient();
  const r = await stageReviewItem(client, sessionCtx, validInput);
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.ok(r.created_at);
  assert.equal(client.queries.length, 1);
  assert.match(client.queries[0].text, /INSERT INTO governance_review_queue/);
  assert.match(client.queries[0].text, /RETURNING id, created_at/);
});

test('stageReviewItem: INSERT params are positional and complete', async () => {
  const client = makeFakeClient();
  await stageReviewItem(client, sessionCtx, validInput);
  const params = client.queries[0].params;
  // [pilot_instance_id, intent_type, reason, policy_ref, proposer_user_id, proposer_role, payload, evidence]
  assert.equal(params.length, 8);
  assert.equal(params[0], PILOT);
  assert.equal(params[1], validInput.decisionIntentType);
  assert.equal(params[2], validInput.decisionReason);
  assert.equal(params[3], validInput.decisionPolicyRef);
  assert.equal(params[4], USER);             // proposer_user_id from sessionCtx, NOT from input
  assert.equal(params[5], validInput.proposerRole);
  // JSONB columns are sent as JSON strings.
  assert.equal(typeof params[6], 'string');
  assert.equal(typeof params[7], 'string');
  assert.deepEqual(JSON.parse(params[6]), validInput.payloadSummary);
  assert.deepEqual(JSON.parse(params[7]), validInput.evidenceSummary);
});

test('stageReviewItem: omitted payload/evidence become NULL params', async () => {
  const client = makeFakeClient();
  const { payloadSummary, evidenceSummary, ...rest } = validInput;
  await stageReviewItem(client, sessionCtx, rest);
  const params = client.queries[0].params;
  assert.equal(params[6], null);
  assert.equal(params[7], null);
});

test('stageReviewItem: proposer_user_id always comes from sessionCtx, not from input', async () => {
  // Verifies the no-impersonation property at the repository layer
  // (defense in depth — the RLS WITH CHECK policy enforces the same
  // at the DB layer).
  const client = makeFakeClient();
  await stageReviewItem(
    client,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    {
      ...validInput,
      // No `proposerUserId` accepted in the input shape at all — but
      // if a malicious caller added one, the repository ignores it.
      proposerUserId: '00000000-0000-0000-0000-deadbeefdead',
    }
  );
  assert.equal(client.queries[0].params[4], USER, 'proposer_user_id must be sessionCtx.userId');
});

test('stageReviewItem: every locked vocabulary value is accepted', async () => {
  const intentTypes = [
    'response.deliver',
    'memory.candidate.create',
    'memory.visibility.promote',
    'memory.retract',
    'memory.supersede',
    'vault.session.open',
    'vault.session.revoke',
    'external.side_effect',
  ];
  for (const decisionIntentType of intentTypes) {
    const client = makeFakeClient();
    await stageReviewItem(client, sessionCtx, { ...validInput, decisionIntentType });
    assert.equal(client.queries.length, 1, `${decisionIntentType} should be accepted`);
  }
});

// ---------------------------------------------------------------------
// GM-24: recordReviewDecision, listPendingReviewItems, inspectReviewItem
// ---------------------------------------------------------------------

const {
  recordReviewDecision,
  listPendingReviewItems,
  inspectReviewItem,
  VALID_REVIEW_OUTCOMES,
  VALID_REVIEW_REASONS,
} = require('../../src/review/repository');

const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const QUEUE_ID = 'eeeeeeee-1111-2222-3333-eeeeeeeeeeee';
const adminCtx = { pilotInstanceId: PILOT, userId: ADMIN, userRole: 'admin' };

function makeFakeDecisionClient() {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params: params || [] });
      if (/INSERT INTO governance_review_decisions[\s\S]*RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'dddddddd-1111-1111-1111-dddddddddddd', reviewed_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const validReviewInput = {
  reviewQueueId: QUEUE_ID,
  reviewOutcome: 'approved',
  reviewReason: 'approved_admin_review',
};

test('recordReviewDecision: rejects missing input', async () => {
  await assert.rejects(
    () => recordReviewDecision(makeFakeDecisionClient(), adminCtx),
    /input is required/
  );
  await assert.rejects(
    () => recordReviewDecision(makeFakeDecisionClient(), adminCtx, null),
    /input is required/
  );
});

test('recordReviewDecision: rejects non-UUID reviewQueueId', async () => {
  const client = makeFakeDecisionClient();
  await assert.rejects(
    () => recordReviewDecision(client, adminCtx, { ...validReviewInput, reviewQueueId: 'x' }),
    /reviewQueueId must be a UUID/
  );
  assert.equal(client.queries.length, 0);
});

test('recordReviewDecision: rejects reviewOutcome outside locked vocabulary', async () => {
  const client = makeFakeDecisionClient();
  await assert.rejects(
    () => recordReviewDecision(client, adminCtx, { ...validReviewInput, reviewOutcome: 'pending' }),
    /reviewOutcome must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('recordReviewDecision: rejects reviewReason outside locked vocabulary', async () => {
  const client = makeFakeDecisionClient();
  await assert.rejects(
    () => recordReviewDecision(client, adminCtx, { ...validReviewInput, reviewReason: 'because' }),
    /reviewReason must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('recordReviewDecision: INSERT shape sources reviewer_user_id from session context, NOT input', async () => {
  const client = makeFakeDecisionClient();
  const inserted = await recordReviewDecision(
    client,
    adminCtx,
    // An attacker passes reviewerUserId in input; the function MUST ignore it.
    Object.assign({}, validReviewInput, { reviewerUserId: 'attacker-id-via-input' })
  );
  assert.equal(client.queries.length, 1);
  const params = client.queries[0].params;
  // SQL parameter positions: $1 pilot, $2 queue, $3 reviewer, $4 role, $5 outcome, $6 reason.
  assert.equal(params[0], PILOT);
  assert.equal(params[1], QUEUE_ID);
  assert.equal(params[2], ADMIN, 'reviewer_user_id must come from session ctx');
  assert.notEqual(params[2], 'attacker-id-via-input');
  assert.equal(params[3], 'admin');
  assert.equal(params[4], 'approved');
  assert.equal(params[5], 'approved_admin_review');
  assert.match(inserted.id, /^[0-9a-f-]{36}$/);
});

test('recordReviewDecision: accepts every value in VALID_REVIEW_OUTCOMES', async () => {
  for (const outcome of VALID_REVIEW_OUTCOMES) {
    const client = makeFakeDecisionClient();
    const reason = outcome === 'approved'
      ? 'approved_admin_review'
      : 'rejected_admin_review';
    await recordReviewDecision(client, adminCtx, { ...validReviewInput, reviewOutcome: outcome, reviewReason: reason });
    assert.equal(client.queries.length, 1, `${outcome} should be accepted`);
  }
});

test('recordReviewDecision: accepts every value in VALID_REVIEW_REASONS', async () => {
  for (const reviewReason of VALID_REVIEW_REASONS) {
    const client = makeFakeDecisionClient();
    const outcome = reviewReason.startsWith('approved_') ? 'approved' : 'rejected';
    await recordReviewDecision(client, adminCtx, { ...validReviewInput, reviewOutcome: outcome, reviewReason });
    assert.equal(client.queries.length, 1, `${reviewReason} should be accepted`);
  }
});

test('listPendingReviewItems: rejects non-positive limit', async () => {
  await assert.rejects(
    () => listPendingReviewItems(makeFakeDecisionClient(), adminCtx, { limit: 0 }),
    /limit must be a positive integer/
  );
  await assert.rejects(
    () => listPendingReviewItems(makeFakeDecisionClient(), adminCtx, { limit: -1 }),
    /limit must be a positive integer/
  );
  await assert.rejects(
    () => listPendingReviewItems(makeFakeDecisionClient(), adminCtx, { limit: 1.5 }),
    /limit must be a positive integer/
  );
});

test('listPendingReviewItems: caps limit at MAX_LIST_LIMIT and uses default when omitted', async () => {
  const client = makeFakeDecisionClient();
  await listPendingReviewItems(client, adminCtx);
  assert.equal(client.queries[0].params[0], 50, 'default limit');
  const client2 = makeFakeDecisionClient();
  await listPendingReviewItems(client2, adminCtx, { limit: 5000 });
  assert.equal(client2.queries[0].params[0], 200, 'capped at MAX_LIST_LIMIT');
});

test('listPendingReviewItems: SELECT LEFT JOINs review_decisions and filters by NULL', async () => {
  const client = makeFakeDecisionClient();
  await listPendingReviewItems(client, adminCtx);
  const sql = client.queries[0].text;
  assert.match(sql, /FROM governance_review_queue/);
  assert.match(sql, /LEFT JOIN governance_review_decisions/);
  assert.match(sql, /WHERE rd\.id IS NULL/);
});

test('inspectReviewItem: rejects non-UUID id', async () => {
  await assert.rejects(
    () => inspectReviewItem(makeFakeDecisionClient(), adminCtx, 'x'),
    /queueId must be a UUID/
  );
});

test('inspectReviewItem: returns null when no row matches', async () => {
  const client = makeFakeDecisionClient(); // returns empty rows for non-RETURNING queries
  const r = await inspectReviewItem(client, adminCtx, QUEUE_ID);
  assert.equal(r, null);
});
