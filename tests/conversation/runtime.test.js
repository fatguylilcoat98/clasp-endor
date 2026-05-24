'use strict';
/*
 * Unit tests for createConversationRuntime. The companion reader and
 * the model SDK are both mocked — no real DB, no real model call.
 *
 * What these tests prove (each maps to a GM-20 invariant):
 *   - createConversationRuntime validates its dependencies before
 *     accepting them;
 *   - the returned runtime is frozen and exposes ONLY `respond`;
 *   - respond() validates inputs BEFORE any companion call;
 *   - respond() invokes companionReader.readVisibleMemories
 *     EXACTLY once per call;
 *   - respond() invokes modelClient.messages.create EXACTLY once
 *     per call;
 *   - the SDK request NEVER contains `tools`, `tool_choice`, or
 *     `stream: true`;
 *   - respond() is stateless (no caching across calls);
 *   - sentinel content planted in memory rows AND in the model
 *     response is absent from captured log lines (the central
 *     privacy assertion);
 *   - validation messages never echo caller-supplied values
 *     (e.g. the user message or a planted suspicious value);
 *   - config defaults are locked and overrideable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createConversationRuntime,
  DEFAULT_CONFIG,
} = require('../../src/conversation/runtime');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const ROW = {
  id: 'aaaaaaaa-cccc-1111-1111-100000000001',
  content: 'a fact',
  provenance: 'USER_STATED',
  visibility_level: 'private',
  admissibility_state: 'admissible',
};

function makeMockReader(rows, errToThrow) {
  let calls = 0;
  return {
    getCalls: () => calls,
    readVisibleMemories: async (params) => {
      calls += 1;
      if (errToThrow) throw errToThrow;
      return rows || [];
    },
  };
}

function makeMockModelClient(responseText, errToThrow) {
  let calls = 0;
  const requests = [];
  return {
    getCalls: () => calls,
    getRequests: () => requests,
    messages: {
      create: async (req) => {
        calls += 1;
        requests.push(req);
        if (errToThrow) throw errToThrow;
        return {
          content: [{ type: 'text', text: responseText || 'OK' }],
        };
      },
    },
  };
}

function makeCapturingLogger() {
  const lines = [];
  return {
    lines,
    info(event, fields) {
      const entry = { ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) };
      lines.push(JSON.stringify(entry));
    },
    asJoinedText() {
      return lines.join('\n');
    },
  };
}

// ---- factory validation ----

test('createConversationRuntime: rejects missing options', () => {
  assert.throws(() => createConversationRuntime(), /options object is required/);
  assert.throws(() => createConversationRuntime(null), /options object is required/);
});

test('createConversationRuntime: rejects missing companionReader', () => {
  assert.throws(
    () => createConversationRuntime({ modelClient: makeMockModelClient() }),
    /companionReader must expose readVisibleMemories/
  );
});

test('createConversationRuntime: rejects companionReader without readVisibleMemories', () => {
  assert.throws(
    () =>
      createConversationRuntime({
        companionReader: { somethingElse: () => {} },
        modelClient: makeMockModelClient(),
      }),
    /companionReader must expose readVisibleMemories/
  );
});

test('createConversationRuntime: rejects missing modelClient', () => {
  assert.throws(
    () => createConversationRuntime({ companionReader: makeMockReader() }),
    /modelClient must expose messages\.create/
  );
});

test('createConversationRuntime: rejects modelClient without messages.create', () => {
  assert.throws(
    () =>
      createConversationRuntime({
        companionReader: makeMockReader(),
        modelClient: { messages: {} },
      }),
    /modelClient must expose messages\.create/
  );
});

test('createConversationRuntime: returned runtime is frozen and exposes ONLY respond', () => {
  const rt = createConversationRuntime({
    companionReader: makeMockReader(),
    modelClient: makeMockModelClient(),
  });
  assert.equal(typeof rt.respond, 'function');
  for (const forbidden of [
    'companionReader',
    'modelClient',
    'pool',
    'handle',
    'connect',
    'query',
    'client',
    'config',
  ]) {
    assert.equal(rt[forbidden], undefined, `runtime must not expose .${forbidden}`);
  }
  assert.equal(Object.isFrozen(rt), true, 'runtime must be frozen');
  assert.throws(() => {
    rt.something = 'else';
  });
});

// ---- config defaults + validation ----

test('createConversationRuntime: DEFAULT_CONFIG is the locked set', () => {
  assert.equal(DEFAULT_CONFIG.model, 'claude-sonnet-4-6');
  assert.equal(DEFAULT_CONFIG.maxTokens, 1024);
  assert.equal(DEFAULT_CONFIG.temperature, 0.3);
  assert.equal(DEFAULT_CONFIG.maxUserMessageBytes, 8192);
  assert.equal(DEFAULT_CONFIG.defaultMemoryLimit, 20);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
});

test('createConversationRuntime: rejects bad config fields', () => {
  const base = { companionReader: makeMockReader(), modelClient: makeMockModelClient() };
  assert.throws(
    () => createConversationRuntime({ ...base, config: { model: '' } }),
    /model must be a non-empty string/
  );
  assert.throws(
    () => createConversationRuntime({ ...base, config: { maxTokens: 0 } }),
    /maxTokens must be a positive integer/
  );
  assert.throws(
    () => createConversationRuntime({ ...base, config: { temperature: 2 } }),
    /temperature must be in/
  );
  assert.throws(
    () => createConversationRuntime({ ...base, config: { maxUserMessageBytes: -1 } }),
    /maxUserMessageBytes must be a positive integer/
  );
  assert.throws(
    () => createConversationRuntime({ ...base, config: { defaultMemoryLimit: 1.5 } }),
    /defaultMemoryLimit must be a positive integer/
  );
});

// ---- input validation BEFORE any I/O ----

test('respond: rejects missing input before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(() => rt.respond(), /input object is required/);
  assert.equal(reader.getCalls(), 0);
  assert.equal(modelClient.getCalls(), 0);
});

test('respond: rejects non-UUID pilotInstanceId before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () => rt.respond({ pilotInstanceId: 'nope', userId: USER, userRole: 'senior', userMessage: 'hi' }),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(reader.getCalls(), 0);
});

test('respond: rejects non-UUID userId before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () => rt.respond({ pilotInstanceId: PILOT, userId: 'nope', userRole: 'senior', userMessage: 'hi' }),
    /userId must be a UUID/
  );
  assert.equal(reader.getCalls(), 0);
});

test('respond: rejects bad userRole before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () => rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'wizard', userMessage: 'hi' }),
    /userRole must be one of/
  );
  assert.equal(reader.getCalls(), 0);
});

test('respond: rejects empty userMessage before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () => rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: '   ' }),
    /userMessage must be a non-empty string/
  );
  assert.equal(reader.getCalls(), 0);
});

test('respond: rejects oversized userMessage and the error never echoes the message', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  const oversized = 'A'.repeat(DEFAULT_CONFIG.maxUserMessageBytes + 1);
  let caught;
  try {
    await rt.respond({
      pilotInstanceId: PILOT,
      userId: USER,
      userRole: 'senior',
      userMessage: oversized,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /userMessage exceeds maximum length/);
  assert.match(caught.message, /\d+\s*>\s*8192/);
  assert.equal(caught.message.includes(oversized), false, 'error must not echo the message');
  assert.equal(reader.getCalls(), 0);
});

test('respond: rejects bad memoryLimit before any companion call', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () =>
      rt.respond({
        pilotInstanceId: PILOT,
        userId: USER,
        userRole: 'senior',
        userMessage: 'hi',
        memoryLimit: 0,
      }),
    /memoryLimit must be a positive integer/
  );
  assert.equal(reader.getCalls(), 0);
});

test('respond: validation error messages never echo planted suspicious values', async () => {
  const reader = makeMockReader();
  const modelClient = makeMockModelClient();
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  const PLANTED = 'SUSPICIOUS_VALUE_555';
  let caught;
  try {
    await rt.respond({
      pilotInstanceId: PLANTED,
      userId: USER,
      userRole: 'senior',
      userMessage: 'hi',
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.message.includes(PLANTED), false);
});

// ---- exactly one of each call ----

test('respond: invokes companionReader.readVisibleMemories EXACTLY once per call', async () => {
  const reader = makeMockReader([ROW]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  assert.equal(reader.getCalls(), 1, 'exactly one memory read per respond');
});

test('respond: invokes modelClient.messages.create EXACTLY once per call', async () => {
  const reader = makeMockReader([ROW]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  assert.equal(modelClient.getCalls(), 1, 'exactly one model call per respond');
});

test('respond: stateless — two calls produce two memory reads and two model calls (no caching)', async () => {
  const reader = makeMockReader([ROW]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  assert.equal(reader.getCalls(), 2);
  assert.equal(modelClient.getCalls(), 2);
});

// ---- SDK request shape ----

test('respond: SDK request NEVER contains streaming/tool-calling fields', async () => {
  const reader = makeMockReader([ROW]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  const [req] = modelClient.getRequests();
  for (const forbidden of ['tools', 'tool_choice', 'tool_use', 'tool_result', 'stream']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(req, forbidden),
      false,
      `SDK request must not contain "${forbidden}"`
    );
  }
});

test('respond: SDK request carries the locked-default model/maxTokens/temperature', async () => {
  const reader = makeMockReader([]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  const [req] = modelClient.getRequests();
  assert.equal(req.model, DEFAULT_CONFIG.model);
  assert.equal(req.max_tokens, DEFAULT_CONFIG.maxTokens);
  assert.equal(req.temperature, DEFAULT_CONFIG.temperature);
  // System prompt is non-empty even when no memories.
  assert.equal(typeof req.system, 'string');
  assert.ok(req.system.length > 0);
  // Messages: exactly one user message.
  assert.equal(Array.isArray(req.messages), true);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, 'user');
  assert.equal(req.messages[0].content, 'hi');
});

test('respond: caller can override config defaults at factory time', async () => {
  const reader = makeMockReader([]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({
    companionReader: reader,
    modelClient,
    config: { model: 'custom-model-99', maxTokens: 256, temperature: 0.0 },
  });
  await rt.respond({ pilotInstanceId: PILOT, userId: USER, userRole: 'senior', userMessage: 'hi' });
  const [req] = modelClient.getRequests();
  assert.equal(req.model, 'custom-model-99');
  assert.equal(req.max_tokens, 256);
  assert.equal(req.temperature, 0.0);
});

test('respond: memoryLimit overrides defaultMemoryLimit on the read', async () => {
  const reader = {
    calls: [],
    readVisibleMemories: async (params) => {
      reader.calls.push(params);
      return [];
    },
  };
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await rt.respond({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
    userMessage: 'hi',
    memoryLimit: 5,
  });
  assert.equal(reader.calls[0].limit, 5);
});

// ---- response extraction ----

test('respond: returns response text from content[0].text', async () => {
  const reader = makeMockReader([]);
  const modelClient = makeMockModelClient('the model said this');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  const result = await rt.respond({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
    userMessage: 'hi',
  });
  assert.equal(result.response, 'the model said this');
  assert.equal(result.memoryCount, 0);
});

test('respond: throws when the model response is malformed', async () => {
  const modelClient = {
    messages: {
      create: async () => ({ content: 'not an array' }),
    },
  };
  const rt = createConversationRuntime({
    companionReader: makeMockReader([]),
    modelClient,
  });
  await assert.rejects(
    () =>
      rt.respond({
        pilotInstanceId: PILOT,
        userId: USER,
        userRole: 'senior',
        userMessage: 'hi',
      }),
    /model response has no content array/
  );
});

// ---- error propagation ----

test('respond: companion-reader errors propagate unmodified', async () => {
  const planted = new Error('reader exploded');
  const reader = makeMockReader([], planted);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  let caught;
  try {
    await rt.respond({
      pilotInstanceId: PILOT,
      userId: USER,
      userRole: 'senior',
      userMessage: 'hi',
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, planted, 'the same Error object propagates');
  assert.equal(modelClient.getCalls(), 0, 'model is not called when the reader failed');
});

test('respond: SDK errors propagate unmodified', async () => {
  const planted = new Error('sdk exploded');
  const reader = makeMockReader([]);
  const modelClient = makeMockModelClient('reply', planted);
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  await assert.rejects(
    () =>
      rt.respond({
        pilotInstanceId: PILOT,
        userId: USER,
        userRole: 'senior',
        userMessage: 'hi',
      }),
    /sdk exploded/
  );
});

// ---- sentinel-content log scan (the central privacy assertion) ----

test('respond: sentinel content in memory rows AND model response NEVER appears in captured logs', async () => {
  const MEMORY_SENTINEL = 'MEMORY_SECRET_DO_NOT_LOG_111';
  const RESPONSE_SENTINEL = 'RESPONSE_SECRET_DO_NOT_LOG_222';
  const USER_MESSAGE_SENTINEL = 'USER_INPUT_DO_NOT_LOG_333';

  const reader = makeMockReader([
    {
      id: 'aaaaaaaa-cccc-1111-1111-100000000099',
      content: `confidential: ${MEMORY_SENTINEL}`,
      provenance: 'USER_STATED',
      visibility_level: 'private',
      admissibility_state: 'admissible',
    },
  ]);
  const modelClient = makeMockModelClient(`the model said ${RESPONSE_SENTINEL}`);
  const log = makeCapturingLogger();
  const rt = createConversationRuntime({ companionReader: reader, modelClient, log });

  const result = await rt.respond({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
    userMessage: `please tell me ${USER_MESSAGE_SENTINEL}`,
  });

  // The model received the user message and the memory content — that
  // is the whole point of the runtime. The CALLER may use the response;
  // the LOG must not contain any of the three sentinels.
  assert.ok(result.response.includes(RESPONSE_SENTINEL), 'caller receives the response unchanged');
  const captured = log.asJoinedText();
  assert.equal(captured.includes(MEMORY_SENTINEL), false, 'memory content must not appear in logs');
  assert.equal(captured.includes(RESPONSE_SENTINEL), false, 'model response must not appear in logs');
  assert.equal(captured.includes(USER_MESSAGE_SENTINEL), false, 'user message must not appear in logs');
  // Sanity: the metadata event was emitted.
  assert.ok(captured.includes('conversation.responded'), 'metadata event must be emitted');
});

test('respond: works without an optional logger', async () => {
  const reader = makeMockReader([]);
  const modelClient = makeMockModelClient('reply');
  const rt = createConversationRuntime({ companionReader: reader, modelClient });
  const result = await rt.respond({
    pilotInstanceId: PILOT,
    userId: USER,
    userRole: 'senior',
    userMessage: 'hi',
  });
  assert.equal(result.response, 'reply');
});

// ---- src/conversation/index re-exports ----

test('src/conversation/index: re-exports createConversationRuntime only', () => {
  const conv = require('../../src/conversation');
  assert.equal(typeof conv.createConversationRuntime, 'function');
  // No re-export of internal helpers.
  assert.equal(conv.buildPrompt, undefined);
  assert.equal(conv.DEFAULT_CONFIG, undefined);
});
