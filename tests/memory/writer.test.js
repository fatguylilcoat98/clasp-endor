'use strict';

/*
 * Unit test for the working-memory writer's correction / supersession
 * path. Verifies the "Daniel poisoned-memory" scenario the user
 * described in the realignment plan:
 *
 *   1. Daniel is already stored as the user's brother.
 *   2. User says "I don't have a brother named Daniel."
 *   3. The writer detects the correction and deactivates the
 *      conflicting memory.
 *   4. A subsequent retrieval (modeled here as a fresh
 *      findActiveMemoriesContaining call) returns nothing.
 *
 * The test mocks both the memory transaction layer (so we don't need
 * a real Postgres) and the fact extractor (so we control the inputs
 * the writer receives). It exercises the real
 * src/memory/writer.js#storeWorkingMemories code path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PILOT_UUID  = '11111111-1111-1111-1111-111111111111';
const USER_UUID   = '22222222-2222-2222-2222-222222222222';

// Mock the transaction + extractor modules before requiring writer.js
// so the writer picks up our stubs. The require cache is cleared per
// test so each scenario starts fresh.
function loadWriterWithMocks(extractorFacts, ctx) {
  const transactionPath = require.resolve('../../src/memory/transaction');
  const extractorPath = require.resolve('../../src/memory/extractor');
  const writerPath = require.resolve('../../src/memory/writer');

  require.cache[transactionPath] = {
    id: transactionPath,
    filename: transactionPath,
    loaded: true,
    exports: {
      withMemoryContext: async (_pool, sessionCtx, fn) => {
        assert.equal(sessionCtx.pilotInstanceId, PILOT_UUID);
        assert.equal(sessionCtx.userId, USER_UUID);
        return await fn(ctx);
      },
    },
  };
  require.cache[extractorPath] = {
    id: extractorPath,
    filename: extractorPath,
    loaded: true,
    exports: {
      extractMemoriableFacts: async () => extractorFacts,
    },
  };
  delete require.cache[writerPath];
  return require(writerPath);
}

function clearMocks() {
  delete require.cache[require.resolve('../../src/memory/transaction')];
  delete require.cache[require.resolve('../../src/memory/extractor')];
  delete require.cache[require.resolve('../../src/memory/writer')];
}

function buildCtx(state) {
  return {
    findActiveMemoriesContaining: async (pattern) => {
      state.searchCalls.push(pattern);
      return (state.activeMemories || []).filter((m) => m.content.includes(pattern));
    },
    deactivateMemory: async (id, reason) => {
      state.deactivateCalls.push({ id, reason });
      const memory = (state.activeMemories || []).find((m) => m.id === id);
      if (memory) memory.active = false;
      // Mirror real ctx: remove from the active set so subsequent
      // findActiveMemoriesContaining returns nothing.
      state.activeMemories = (state.activeMemories || []).filter((m) => m.id !== id);
    },
    findWorkingMemoriesByContent: async () => [],
    promoteMemoryToVerified: async () => {},
    insertPrivateMemory: async (input) => {
      const id = `mem-${state.insertCalls.length + 1}`;
      state.insertCalls.push({ id, ...input });
      return { id, created_at: new Date() };
    },
  };
}

test('Daniel poisoned-memory: correction deactivates the existing brother row', async () => {
  const state = {
    activeMemories: [
      { id: 'mem-daniel', content: "User's brother is named Daniel", active: true },
    ],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);

  const facts = [
    {
      content: 'CORRECTION: User does not have brother named Daniel',
      confidence: 0.9,
    },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    const result = await writer.storeWorkingMemories({
      userMessage: "I don't have a brother named Daniel",
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
    });

    // 1. The writer searched for the conflicting memory.
    assert.deepEqual(state.searchCalls, ["User's brother is named Daniel"]);
    // 2. The writer deactivated it with the USER_CORRECTED reason.
    assert.equal(state.deactivateCalls.length, 1);
    assert.equal(state.deactivateCalls[0].id, 'mem-daniel');
    assert.equal(state.deactivateCalls[0].reason, 'USER_CORRECTED');
    // 3. The correction itself was stored as a WORKING_ACTIVE memory.
    assert.equal(state.insertCalls.length, 1);
    assert.equal(state.insertCalls[0].provenance, 'USER_STATED');
    assert.equal(state.insertCalls[0].memoryStatus, 'WORKING_ACTIVE');
    // 4. The active set no longer contains the Daniel row.
    assert.equal(state.activeMemories.length, 0);
    // 5. The writer reports the operation.
    assert.equal(result.stored, 1);
    assert.equal(result.extracted, 1);
  } finally {
    clearMocks();
  }
});

test('Daniel poisoned-memory: a fresh retrieval after correction returns nothing', async () => {
  const state = {
    activeMemories: [
      { id: 'mem-daniel', content: "User's brother is named Daniel", active: true },
    ],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);
  const facts = [
    {
      content: 'CORRECTION: User does not have brother named Daniel',
      confidence: 0.9,
    },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    await writer.storeWorkingMemories({
      userMessage: "I don't have a brother named Daniel",
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
    });

    // Simulate a brand-new session looking up "brother is named Daniel".
    const post = await ctx.findActiveMemoriesContaining("User's brother is named Daniel");
    assert.equal(post.length, 0, 'corrected memory must not resurface in a new lookup');
  } finally {
    clearMocks();
  }
});

test('preference correction: "I do not like pineapple on pizza" deactivates "User likes pineapple on pizza"', async () => {
  const state = {
    activeMemories: [
      { id: 'mem-pineapple', content: 'User likes pineapple on pizza', active: true },
    ],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);
  const facts = [
    {
      content: 'CORRECTION: User does not like pineapple on pizza',
      confidence: 0.85,
    },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    await writer.storeWorkingMemories({
      userMessage: "Actually, I don't like pineapple on pizza",
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
    });
    assert.equal(state.deactivateCalls.length, 1);
    assert.equal(state.deactivateCalls[0].id, 'mem-pineapple');
    assert.equal(state.deactivateCalls[0].reason, 'USER_CORRECTED');
  } finally {
    clearMocks();
  }
});

test('retraction: "Forget what I said about X" deactivates memories containing X', async () => {
  const state = {
    activeMemories: [
      { id: 'mem-google', content: 'User works at Google as an engineer', active: true },
    ],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);
  // The retraction pattern extracts the topic from
  // "Ignore previous statements about (topic)" and searches for it as
  // a substring in active memories. The memory content above contains
  // "Google" so the search matches.
  const facts = [
    {
      content: 'RETRACTION: Ignore previous statements about Google',
      confidence: 0.9,
    },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    await writer.storeWorkingMemories({
      userMessage: 'Forget what I said about working at Google',
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
    });
    assert.equal(state.deactivateCalls.length, 1);
    assert.equal(state.deactivateCalls[0].id, 'mem-google');
    assert.equal(state.deactivateCalls[0].reason, 'USER_RETRACTED');
  } finally {
    clearMocks();
  }
});

test('non-correction facts go straight to insert (no deactivation)', async () => {
  const state = {
    activeMemories: [],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);
  const facts = [
    { content: "User's favorite color is blue", confidence: 0.9 },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    const result = await writer.storeWorkingMemories({
      userMessage: 'My favorite color is blue',
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
    });
    assert.equal(state.deactivateCalls.length, 0);
    assert.equal(state.insertCalls.length, 1);
    assert.equal(state.insertCalls[0].content, "User's favorite color is blue");
    assert.equal(result.stored, 1);
  } finally {
    clearMocks();
  }
});

test('low-confidence facts are dropped before reaching insert', async () => {
  const state = {
    activeMemories: [],
    searchCalls: [],
    deactivateCalls: [],
    insertCalls: [],
  };
  const ctx = buildCtx(state);
  const facts = [
    { content: 'Maybe user likes coffee', confidence: 0.3 },
  ];
  const { createMemoryWriter } = loadWriterWithMocks(facts, ctx);
  try {
    const writer = createMemoryWriter({ memoryPool: {}, logger: null });
    const result = await writer.storeWorkingMemories({
      userMessage: 'I think I might like coffee',
      pilotInstanceId: PILOT_UUID,
      userId: USER_UUID,
      userRole: 'senior',
      options: { minConfidence: 0.5 },
    });
    assert.equal(state.insertCalls.length, 0);
    assert.equal(result.stored, 0);
  } finally {
    clearMocks();
  }
});
