'use strict';
/*
 * Unit tests for the companion reader. The memory pool is mocked —
 * no real DB.
 *
 * What these tests prove:
 *   - createCompanionReader validates its options.
 *   - readVisibleMemories validates input shape BEFORE delegating to
 *     withMemoryContext (no DB call on validation failure).
 *   - The returned reader exposes ONLY readVisibleMemories — never
 *     the pool, the handle, or a connect/query method.
 *   - The reader passes limit through and returns rows unchanged.
 *   - Captured log output never contains memory content (sentinel
 *     scan — the central privacy guarantee for the consumer).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanionReader } = require('../../src/companion/reader');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

// A duck-typed mock that satisfies _resolvePool's "mock with .connect"
// branch in src/memory/client.js, so we don't need a real
// MemoryPoolHandle here.
function makeMockMemoryPool(fakeRows) {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    query: async (text) => {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return { rows: [{ id: 'x', created_at: new Date() }], rowCount: 1 };
      }
      // memory_store SELECT — return the planted fixture rows.
      if (/memory_store/i.test(text) && /SELECT/i.test(text)) {
        return { rows: fakeRows || [], rowCount: (fakeRows || []).length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    connect: async () => {
      connectCalls += 1;
      return client;
    },
    getConnectCalls: () => connectCalls,
    getQueries: () => queries,
  };
}

function makeCapturingLogger() {
  const lines = [];
  const fakeStdout = (chunk) => {
    lines.push(String(chunk));
  };
  return {
    lines,
    info(event, fields) {
      const entry = { ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) };
      fakeStdout(JSON.stringify(entry) + '\n');
    },
    asJoinedText() {
      return lines.join('');
    },
  };
}

// ---- createCompanionReader: options validation ----

test('createCompanionReader: rejects missing options', () => {
  assert.throws(() => createCompanionReader(), /options object is required/);
  assert.throws(() => createCompanionReader(null), /options object is required/);
});

test('createCompanionReader: rejects missing memoryPool', () => {
  assert.throws(() => createCompanionReader({}), /memoryPool is required/);
  assert.throws(() => createCompanionReader({ memoryPool: null }), /memoryPool is required/);
});

test('createCompanionReader: returned reader exposes ONLY readVisibleMemories and is frozen', () => {
  const reader = createCompanionReader({ memoryPool: makeMockMemoryPool() });
  assert.equal(typeof reader.readVisibleMemories, 'function');
  for (const forbidden of ['memoryPool', 'pool', 'handle', 'connect', 'query', 'client']) {
    assert.equal(reader[forbidden], undefined, `reader must not expose .${forbidden}`);
  }
  assert.equal(Object.isFrozen(reader), true, 'reader object must be frozen');
  assert.throws(() => {
    reader.somethingElse = () => 42;
  });
  assert.equal(reader.somethingElse, undefined);
});

// ---- readVisibleMemories: input validation (BEFORE any DB call) ----

test('readVisibleMemories: rejects missing input object before any DB call', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  await assert.rejects(() => reader.readVisibleMemories(), /input object is required/);
  assert.equal(pool.getConnectCalls(), 0, 'pool.connect must not have been called');
});

test('readVisibleMemories: rejects non-UUID pilotInstanceId before any DB call', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  await assert.rejects(
    () => reader.readVisibleMemories({ pilotInstanceId: 'nope', userId: USER, userRole: 'senior' }),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('readVisibleMemories: rejects non-UUID userId before any DB call', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  await assert.rejects(
    () => reader.readVisibleMemories({ pilotInstanceId: PILOT, userId: 'nope', userRole: 'senior' }),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('readVisibleMemories: rejects bad userRole before any DB call', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  await assert.rejects(
    () => reader.readVisibleMemories({ pilotInstanceId: PILOT, userId: USER, userRole: 'wizard' }),
    /userRole must be one of/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('readVisibleMemories: rejects non-positive-integer limit before any DB call', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  for (const limit of [0, -1, 1.5, 'ten', {}]) {
    await assert.rejects(
      () => reader.readVisibleMemories({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', limit }),
      /limit must be a positive integer/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- happy-path behavior ----

test('readVisibleMemories: returns the rows from listVisibleMemories unchanged', async () => {
  const fixtureRows = [
    { id: 'aaa', content: 'one', provenance: 'USER_STATED' },
    { id: 'bbb', content: 'two', provenance: 'VERIFIED_FACT' },
  ];
  const pool = makeMockMemoryPool(fixtureRows);
  const reader = createCompanionReader({ memoryPool: pool });
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
  });
  assert.deepEqual(rows, fixtureRows);
});

test('readVisibleMemories: passes limit through (round-trips into the SELECT)', async () => {
  const pool = makeMockMemoryPool([]);
  const reader = createCompanionReader({ memoryPool: pool });
  await reader.readVisibleMemories({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
    limit: 7,
  });
  // The repository's SELECT statement carries LIMIT $1 — confirm a
  // SELECT query was issued (the actual LIMIT param plumbing is
  // unit-tested in tests/memory/).
  assert.ok(
    pool.getQueries().some((q) => /SELECT.*FROM memory_store.*LIMIT/i.test(q)),
    'a memory_store SELECT with LIMIT must have been issued'
  );
});

// ---- logging hygiene (the central privacy assertion) ----

test('readVisibleMemories: sentinel content NEVER appears in captured log lines', async () => {
  const SENTINEL = 'SENTINEL_DO_NOT_LOG_ME_42';
  const fixtureRows = [
    {
      id: 'aaa',
      owning_user_id: USER,
      content: `the secret is ${SENTINEL}`,
      provenance: 'USER_STATED',
      visibility_level: 'private',
      admissibility_state: 'admissible',
    },
  ];
  const pool = makeMockMemoryPool(fixtureRows);
  const log = makeCapturingLogger();
  const reader = createCompanionReader({ memoryPool: pool, log });
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
  });
  // Reader returned the content — that's expected; the caller may use it.
  assert.equal(rows[0].content, `the secret is ${SENTINEL}`);
  // But the log lines MUST NOT include the sentinel.
  const captured = log.asJoinedText();
  assert.equal(
    captured.includes(SENTINEL),
    false,
    `captured logs must not contain memory content; got: ${captured}`
  );
  // Sanity: at least one companion.memory.read line was emitted.
  assert.ok(captured.includes('companion.memory.read'), 'reader must have logged the metadata event');
});

test('readVisibleMemories: validation-error messages never echo caller-supplied values', async () => {
  const pool = makeMockMemoryPool();
  const reader = createCompanionReader({ memoryPool: pool });
  const PLANTED = 'SUSPICIOUS_VALUE_777';
  let caught;
  try {
    await reader.readVisibleMemories({
      pilotInstanceId: PLANTED,
      userId: USER,
      userRole: 'senior',
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(
    caught.message.includes(PLANTED),
    false,
    'validation error message must not echo the offending caller-supplied value'
  );
});

test('readVisibleMemories: works without an optional logger (no-op when log is omitted)', async () => {
  const pool = makeMockMemoryPool([]);
  const reader = createCompanionReader({ memoryPool: pool });
  // No log passed.
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
  });
  assert.deepEqual(rows, []);
});

test('readVisibleMemories: a log object without .info is ignored (no throw)', async () => {
  const pool = makeMockMemoryPool([]);
  const reader = createCompanionReader({ memoryPool: pool, log: { warn: () => {} } });
  const rows = await reader.readVisibleMemories({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
  });
  assert.deepEqual(rows, []);
});

// ---- index.js re-exports ----

test('src/companion/index: re-exports createCompanionReader and MemoryRepositoryError', () => {
  const companion = require('../../src/companion');
  assert.equal(typeof companion.createCompanionReader, 'function');
  assert.equal(typeof companion.MemoryRepositoryError, 'function');
  assert.equal(companion.MemoryRepositoryError.name, 'MemoryRepositoryError');
  // index must NOT expose the memory pool factory; that's only
  // available through src/memory directly.
  assert.equal(companion.createMemoryPool, undefined);
  assert.equal(companion.withMemoryContext, undefined);
});
