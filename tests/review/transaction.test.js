'use strict';
/*
 * Unit tests for withReviewContext — mirrors the structure of
 * tests/memory/transaction.test.js, no real DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withReviewContext } = require('../../src/review/transaction');
const { ReviewRepositoryError } = require('../../src/review/errors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeFakeClient() {
  const queries = [];
  let released = false;
  return {
    queries,
    isReleased: () => released,
    query: async (text, params) => {
      queries.push({ text, params: params || [] });
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', created_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
}

function makeFakePool(client) {
  return { connect: async () => client };
}

test('withReviewContext: rejects a missing pool with a ReviewPoolHandle message', async () => {
  await assert.rejects(
    () => withReviewContext(null, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async () => {}),
    /pool must be a ReviewPoolHandle/
  );
});

test('withReviewContext: rejects a non-function callback', async () => {
  const pool = makeFakePool(makeFakeClient());
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, null),
    /callback function is required/
  );
});

test('withReviewContext: rejects non-UUID identifiers BEFORE any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: 'nope', userId: USER, userRole: 'senior' }, async () => {}),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: PILOT, userId: 'nope', userRole: 'senior' }, async () => {}),
    /userId must be a UUID/
  );
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'wizard' }, async () => {}),
    /userRole must be one of/
  );
  assert.equal(client.queries.length, 0, 'no DB query may be issued on validation failure');
});

test('withReviewContext: BEGIN, 3× set_config, fn, COMMIT — in that order', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async (ctx) => {
    assert.equal(ctx.pilotInstanceId, PILOT);
    assert.equal(ctx.userId, USER);
    assert.equal(ctx.userRole, 'senior');
    assert.equal(typeof ctx.stageReviewItem, 'function');
    // The raw client must NOT be exposed.
    assert.equal(ctx.query, undefined);
    assert.equal(ctx.client, undefined);
  });
  assert.equal(client.isReleased(), true, 'client must be released');
  const texts = client.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'COMMIT',
  ]);
});

test('withReviewContext: ROLLBACK on throw; client still released', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  const texts = client.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'ROLLBACK',
  ]);
  assert.equal(client.isReleased(), true);
});

test('withReviewContext: pg-shaped errors thrown inside fn become ReviewRepositoryError', async () => {
  const client = {
    queries: [],
    query: async (text) => {
      if (text === 'BEGIN' || text.startsWith('SELECT set_config') || text === 'ROLLBACK' || text === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      err.detail = 'Key (payload_summary)=(SECRET_PAYLOAD) already exists.';
      err.where = 'PL/pgSQL function...';
      err.routine = '_bt_check_unique';
      throw err;
    },
    release: () => {},
  };
  const pool = { connect: async () => client };

  let caught;
  try {
    await withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async (ctx) => {
      // Stub a fake op that goes through client.query — verifies the
      // wrapper kicks in for any pg error originating in fn(ctx).
      await ctx.stageReviewItem({
        decisionIntentType: 'memory.candidate.create',
        decisionReason: 'ai_inferred_requires_review',
        decisionPolicyRef: 'source-of-truth-memory-policy.md §3, §5',
        proposerRole: 'senior',
      });
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ReviewRepositoryError);
  assert.equal(caught.name, 'ReviewRepositoryError');
  assert.equal(caught.error_class, '23505');
  assert.equal(caught.message, 'review operation failed');
  assert.equal(caught.detail, undefined);
  assert.equal(caught.where, undefined);
  assert.equal(caught.routine, undefined);
  const serialized = JSON.stringify({ name: caught.name, message: caught.message, error_class: caught.error_class });
  assert.equal(serialized.includes('SECRET_PAYLOAD'), false);
});

test('withReviewContext: caller-contract validation errors pass through unchanged', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withReviewContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async (ctx) => {
      await ctx.stageReviewItem({}); // throws "input is required" — plain Error, no SQLSTATE
    }),
    (err) => err.name === 'Error' && !(err instanceof ReviewRepositoryError)
  );
});

test('withReviewContext: opaque handle from createReviewQueuePool roundtrips through _resolvePool', async () => {
  const { createReviewQueuePool, closeReviewQueuePool } = require('../../src/review/client');
  const handle = createReviewQueuePool('postgres://127.0.0.1:1/nonexistent', { connectionTimeoutMillis: 50 });
  try {
    // pool.connect will fail (no DB) — but the test's point is that
    // _resolvePool successfully unwrapped the handle (no "must be a
    // ReviewPoolHandle" guard fired).
    await assert.rejects(
      () => withReviewContext(handle, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async () => {}),
      (err) => !/must be a ReviewPoolHandle/.test(err.message)
    );
  } finally {
    await closeReviewQueuePool(handle);
  }
});

test('createReviewQueuePool: handle is opaque (no .connect / .query / .end)', () => {
  const { createReviewQueuePool } = require('../../src/review/client');
  const handle = createReviewQueuePool('postgres://example/db');
  assert.equal(handle.connect, undefined);
  assert.equal(handle.query, undefined);
  assert.equal(handle.end, undefined);
  assert.equal(Object.isFrozen(handle), true);
  assert.throws(() => { handle.connect = () => {}; });
});
