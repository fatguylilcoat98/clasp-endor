'use strict';
/*
 * Unit tests for withMemoryContext. The pool is mocked — no real DB.
 * These tests check the transaction-discipline contract:
 *   - validation throws before any DB work
 *   - BEGIN + 3 set_config calls + fn + COMMIT in that order
 *   - ROLLBACK on any throw inside fn
 *   - client.release() runs on every path
 *   - ctx exposes the bundled ops, NOT the raw client
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMemoryContext } = require('../../src/memory/transaction');

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
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  };
}

function makeFakePool(client) {
  return {
    connect: async () => client,
  };
}

test('withMemoryContext: rejects a missing pool', async () => {
  await assert.rejects(
    () => withMemoryContext(null, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async () => {}),
    /pool must be a pg\.Pool/
  );
});

test('withMemoryContext: rejects a non-function callback', async () => {
  const pool = makeFakePool(makeFakeClient());
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, null),
    /callback function is required/
  );
});

test('withMemoryContext: rejects a non-UUID pilotInstanceId before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: 'not-a-uuid', userId: USER, userRole: 'senior' }, async () => {}),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(client.queries.length, 0, 'no DB query must have been issued');
});

test('withMemoryContext: rejects a non-UUID userId before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: 'not-a-uuid', userRole: 'senior' }, async () => {}),
    /userId must be a UUID/
  );
  assert.equal(client.queries.length, 0);
});

test('withMemoryContext: rejects an unknown userRole before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'godmode' }, async () => {}),
    /userRole must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('withMemoryContext: rejects a blank pilotInstanceId / userId / userRole', async () => {
  const pool = makeFakePool(makeFakeClient());
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: '', userId: USER, userRole: 'senior' }, async () => {}),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: '', userRole: 'senior' }, async () => {}),
    /userId must be a UUID/
  );
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: '' }, async () => {}),
    /userRole must be one of/
  );
});

test('withMemoryContext: BEGIN, three set_config bindings, fn, COMMIT — in that order', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  let fnRan = false;

  await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async (ctx) => {
      fnRan = true;
      assert.equal(ctx.pilotInstanceId, PILOT);
      assert.equal(ctx.userId, USER);
      assert.equal(ctx.userRole, 'senior');
      // The ctx exposes the bundled ops only — never the raw client.
      assert.equal(typeof ctx.listVisibleMemories, 'function');
      assert.equal(typeof ctx.insertPrivateMemory, 'function');
      assert.equal(ctx.query, undefined, 'ctx must not expose raw client.query');
      assert.equal(ctx.client, undefined, 'ctx must not expose the raw client');
    }
  );

  assert.equal(fnRan, true);
  assert.equal(client.isReleased(), true, 'client must be released back to the pool');

  const texts = client.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'COMMIT',
  ]);

  const sets = client.queries.slice(1, 4);
  assert.deepEqual(sets[0].params, ['app.pilot_instance_id', PILOT]);
  assert.deepEqual(sets[1].params, ['app.user_id', USER]);
  assert.deepEqual(sets[2].params, ['app.user_role', 'senior']);
});

test('withMemoryContext: ROLLBACK on any throw inside fn; client still released', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);

  await assert.rejects(
    () =>
      withMemoryContext(
        pool,
        { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
        async () => {
          throw new Error('boom');
        }
      ),
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
  assert.equal(client.isReleased(), true, 'client must be released even after a throw');
});

test('withMemoryContext: set_config is parameterized, not interpolated', async () => {
  // Defends against a regression where someone "simplifies" the
  // session-var binding into a raw SET LOCAL statement and reintroduces
  // SQL injection.
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async () => {}
  );
  for (const q of client.queries.slice(1, 4)) {
    assert.equal(q.text, 'SELECT set_config($1, $2, true)');
    assert.equal(q.params.length, 2);
  }
});

test('withMemoryContext: returns the fn result', async () => {
  const pool = makeFakePool(makeFakeClient());
  const result = await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async () => 42
  );
  assert.equal(result, 42);
});
