'use strict';
/*
 * Mounted conversation runtime — GM-20.
 *
 * The first place in the codebase where a model inference call
 * happens. Strictly single-shot, strictly read-only, strictly
 * non-agentic. The locked contract is
 * docs/governance/conversation-runtime-boundary.md.
 *
 * Architecture (the chain of responsibility):
 *
 *   conversation/runtime  → companion/reader  → memory  → db  → Postgres
 *                                                     (audit-bundled, RLS-narrowed)
 *
 * The runtime imports the companion module only via its public entry
 * (`../companion`). It does NOT import `../memory`, `../runtime`,
 * `../db`, or any deeper path — `check-conversation-boundary.js`
 * enforces this.
 *
 * Per-respond contract (every invariant is asserted by tests):
 *
 *   1. Inputs validated BEFORE any I/O.
 *   2. Exactly ONE call to companionReader.readVisibleMemories.
 *      That call audit-bundles one memory.list row by virtue of the
 *      GM-17 contract.
 *   3. Exactly ONE call to modelClient.messages.create.
 *      Non-streaming. No tool / function calling. No retries
 *      (caller must construct the SDK client with maxRetries: 0 —
 *      OQ-20.16).
 *   4. No write path. No persistence. No second pass. No
 *      transcript table. No automatic memory creation. No caching
 *      across respond() invocations — the runtime is stateless.
 *   5. The response is returned to the caller; the runtime never
 *      logs it.
 */

const { buildPrompt } = require('./prompt');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

// Locked defaults (OQ-20.10, OQ-20.11, OQ-20.12, OQ-20.13).
const DEFAULT_CONFIG = Object.freeze({
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  temperature: 0.3,
  maxUserMessageBytes: 8192,
  defaultMemoryLimit: 20,
});

function resolveConfig(override) {
  const overrides = override || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    out[key] = overrides[key] !== undefined ? overrides[key] : DEFAULT_CONFIG[key];
  }
  if (typeof out.model !== 'string' || out.model.trim() === '') {
    throw new Error('createConversationRuntime: config.model must be a non-empty string');
  }
  if (!(Number.isInteger(out.maxTokens) && out.maxTokens > 0)) {
    throw new Error('createConversationRuntime: config.maxTokens must be a positive integer');
  }
  if (typeof out.temperature !== 'number' || out.temperature < 0 || out.temperature > 1) {
    throw new Error('createConversationRuntime: config.temperature must be in [0, 1]');
  }
  if (!(Number.isInteger(out.maxUserMessageBytes) && out.maxUserMessageBytes > 0)) {
    throw new Error(
      'createConversationRuntime: config.maxUserMessageBytes must be a positive integer'
    );
  }
  if (!(Number.isInteger(out.defaultMemoryLimit) && out.defaultMemoryLimit > 0)) {
    throw new Error(
      'createConversationRuntime: config.defaultMemoryLimit must be a positive integer'
    );
  }
  return Object.freeze(out);
}

function validateInputs(input, cfg) {
  if (!input || typeof input !== 'object') {
    throw new Error('respond: input object is required');
  }
  const { pilotInstanceId, userId, userRole, userMessage, memoryLimit } = input;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('respond: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('respond: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `respond: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
  if (typeof userMessage !== 'string' || userMessage.trim() === '') {
    throw new Error('respond: userMessage must be a non-empty string');
  }
  const messageBytes = Buffer.byteLength(userMessage, 'utf8');
  if (messageBytes > cfg.maxUserMessageBytes) {
    // Report length + limit only; never echo the user message itself.
    throw new Error(
      `respond: userMessage exceeds maximum length (${messageBytes} > ${cfg.maxUserMessageBytes} bytes)`
    );
  }
  if (
    memoryLimit !== undefined
    && memoryLimit !== null
    && !(Number.isInteger(memoryLimit) && memoryLimit > 0)
  ) {
    throw new Error('respond: memoryLimit must be a positive integer when provided');
  }
}

function isMessagesCreateClient(modelClient) {
  return (
    modelClient
    && typeof modelClient === 'object'
    && modelClient.messages
    && typeof modelClient.messages.create === 'function'
  );
}

function isCompanionReader(companionReader) {
  return (
    companionReader
    && typeof companionReader === 'object'
    && typeof companionReader.readVisibleMemories === 'function'
  );
}

// Extract the response text from the Anthropic SDK response shape.
// The SDK returns { content: [{ type: 'text', text: '...' }, ...] }.
// We concatenate text blocks; non-text blocks (which only appear when
// tool calling is enabled and which we forbid) would be skipped.
function extractResponseText(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('respond: model response was not an object');
  }
  const blocks = response.content;
  if (!Array.isArray(blocks)) {
    throw new Error('respond: model response has no content array');
  }
  const parts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

function createConversationRuntime(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createConversationRuntime: options object is required');
  }
  const { companionReader, modelClient, log } = options;
  if (!isCompanionReader(companionReader)) {
    throw new Error(
      'createConversationRuntime: companionReader must expose readVisibleMemories'
    );
  }
  if (!isMessagesCreateClient(modelClient)) {
    throw new Error(
      'createConversationRuntime: modelClient must expose messages.create'
    );
  }
  const cfg = resolveConfig(options.config);
  const logger = log && typeof log.info === 'function' ? log : null;

  async function respond(input) {
    validateInputs(input, cfg);
    const { pilotInstanceId, userId, userRole, userMessage, memoryLimit } = input;

    const limit = memoryLimit || cfg.defaultMemoryLimit;
    const memoryRows = await companionReader.readVisibleMemories({
      pilotInstanceId,
      userId,
      userRole,
      limit,
    });

    const prompt = buildPrompt({ memoryRows, userMessage });

    const sdkRequest = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      system: prompt.system,
      messages: prompt.messages,
    };
    // Single-shot, non-streaming, no tool calling. The boundary guard
    // rejects the field names that would enable those modes; we
    // additionally never set them here.
    const response = await modelClient.messages.create(sdkRequest);
    const responseText = extractResponseText(response);

    if (logger) {
      // Metadata only — never the user message, never the rows,
      // never the response text. The sentinel-scan unit test
      // verifies this by planting secrets in both inputs and outputs
      // and asserting they do not appear in any captured log line.
      logger.info('conversation.responded', {
        pilot_instance_id: pilotInstanceId,
        actor_user_id: userId,
        actor_role: userRole,
        memory_count: memoryRows.length,
        response_chars: responseText.length,
      });
    }

    return {
      response: responseText,
      memoryCount: memoryRows.length,
    };
  }

  return Object.freeze({ respond });
}

module.exports = {
  createConversationRuntime,
  DEFAULT_CONFIG,
};
