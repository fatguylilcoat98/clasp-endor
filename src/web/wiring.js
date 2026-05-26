'use strict';
/*
 * Test-door wiring.
 *
 * The single place in the test-door web layer that imports the
 * Anthropic SDK and constructs the conversation chain. Kept outside
 * src/runtime/ so the runtime-boundary CI guard (which bans model-SDK
 * imports) remains satisfied — the runtime never depends on this file.
 *
 * Composition order (no governance bypass):
 *   modelClient        — @anthropic-ai/sdk, maxRetries: 0
 *   memoryPool         — opaque handle from src/memory (lylo_app role)
 *   companionReader    — src/companion (governed read surface)
 *   conversationRuntime— src/conversation (single-shot, no tools)
 *   responseActor      — src/actors/response-delivery-actor
 *
 * Every chat request must:
 *   1. classifyExecutionIntent({type: RESPONSE_DELIVER}) → Decision
 *   2. responseActor.execute(decision, params) → outcome bundle
 *
 * The web layer NEVER constructs a Decision directly, NEVER calls the
 * conversation runtime directly, NEVER mocks the model client. Tests
 * inject a fake modelClient via the createTestDoorWiring options.
 */

const Anthropic = require('@anthropic-ai/sdk');

const { createMemoryPool, closeMemoryPool, createMemoryWriter } = require('../memory');
const { createCompanionReader } = require('../companion');
const { createConversationRuntime } = require('../conversation/runtime');
const { createResponseDeliveryActor } = require('../actors');
const {
  classifyExecutionIntent,
  INTENT_TYPES,
  DECISION_OUTCOMES,
} = require('../governance');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeErrClass(err) {
  if (!err) return 'unknown';
  if (err && typeof err === 'object') {
    if (err.status) return `http_${err.status}`;
    if (err.code) return String(err.code);
    if (err.name) return String(err.name);
  }
  return 'error';
}

function buildModelClient(env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('test-door wiring: ANTHROPIC_API_KEY is required');
  }
  return new Anthropic({ apiKey, maxRetries: 0 });
}

function buildLogAdapter(emit) {
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/*
 * createTestDoorWiring
 *   options:
 *     env             — typically process.env; reads ANTHROPIC_API_KEY,
 *                       LYLO_APP_DATABASE_URL.
 *     log             — (level, event, fields) callback. Required.
 *     modelClient     — optional; when present, overrides Anthropic
 *                       construction. Tests inject a fake here.
 *     memoryPool      — optional; when present, skips createMemoryPool.
 *                       Tests inject a fake here.
 *     runtimeConfig   — optional override forwarded to
 *                       createConversationRuntime (model, maxTokens,
 *                       temperature, ...). The locked defaults from
 *                       src/conversation/runtime.js apply otherwise.
 */
function createTestDoorWiring(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createTestDoorWiring: options object is required');
  }
  const { env, log, runtimeConfig } = options;
  if (!env || typeof env !== 'object') {
    throw new Error('createTestDoorWiring: env object is required');
  }
  if (typeof log !== 'function') {
    throw new Error('createTestDoorWiring: log(level, event, fields) callback is required');
  }

  const modelClient = options.modelClient || buildModelClient(env);

  let ownsPool = false;
  let memoryPool = options.memoryPool;
  if (!memoryPool) {
    const dbUrl = env.LYLO_APP_DATABASE_URL;
    if (typeof dbUrl !== 'string' || dbUrl.trim() === '') {
      throw new Error('test-door wiring: LYLO_APP_DATABASE_URL is required');
    }
    memoryPool = createMemoryPool(dbUrl, { log });
    ownsPool = true;
  }

  const logAdapter = buildLogAdapter(log);
  const companionReader = createCompanionReader({ memoryPool, log: logAdapter });
  const memoryWriter = createMemoryWriter({ memoryPool, logger: logAdapter });
  const conversationRuntime = createConversationRuntime({
    companionReader,
    modelClient,
    log: logAdapter,
    config: runtimeConfig,
  });
  const responseActor = createResponseDeliveryActor({
    conversationRuntime,
    log: logAdapter,
  });

  async function handleChat(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('handleChat: params object is required');
    }
    const { pilotInstanceId, userId, userRole, userMessage, companionConfig } = params;
    if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
      const err = new Error('handleChat: pilotInstanceId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      const err = new Error('handleChat: userId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userRole !== 'string' || userRole.length === 0) {
      const err = new Error('handleChat: userRole is required');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userMessage !== 'string' || userMessage.trim() === '') {
      const err = new Error('handleChat: userMessage is required');
      err.userClass = 'bad_request';
      throw err;
    }

    const decision = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
    const result = await responseActor.execute(decision, {
      pilotInstanceId,
      userId,
      userRole,
      userMessage,
      companionConfig,
    });

    // Store working memories from user message after successful response
    let memoryWriteResult = null;
    if (result.outcome === 'executed') {
      try {
        memoryWriteResult = await memoryWriter.storeWorkingMemories({
          userMessage,
          pilotInstanceId,
          userId,
          userRole,
          options: { minConfidence: 0.5 }
        });
      } catch (error) {
        // Log error but don't fail the chat response
        if (log) {
          log('warn', 'wiring.memory_write_failed', {
            error_class: describeErrClass(error),
            message: error.message?.substring(0, 100)
          });
        }
      }
    }

    const bundle = {
      outcome: result.outcome,
      decision: result.decision.decision,
      intentType: result.decision.intentType,
      reason: result.decision.reason,
      policyRef: result.decision.policyRef,
      response: typeof result.response === 'string' ? result.response : '',
      memoryCount: typeof result.memoryCount === 'number' ? result.memoryCount : 0,
      auditVerdict: result.auditVerdict || 'N/A',
      auditDetails: result.auditDetails || 'no-audit',
      auditReason: result.auditReason,
      memoriesStored: memoryWriteResult?.stored || 0,
      factsExtracted: memoryWriteResult?.extracted || 0,
    };
    bundle.executed = bundle.outcome === 'executed';
    return bundle;
  }

  async function close() {
    if (ownsPool && memoryPool) await closeMemoryPool(memoryPool);
  }

  return Object.freeze({
    handleChat,
    close,
    classifierOutcomes: DECISION_OUTCOMES,
  });
}

module.exports = {
  createTestDoorWiring,
  describeErrClass,
};
