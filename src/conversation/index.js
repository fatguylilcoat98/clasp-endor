'use strict';
/*
 * Conversation runtime public API — GM-20.
 *
 * The first mounted conversational runtime path. Library-only: no
 * boot integration, no HTTP endpoint, no process mount. Future GMs
 * that introduce a production caller (with its own auth and request
 * shape) will be the first production callers.
 *
 * Surface:
 *   - createConversationRuntime({ companionReader, modelClient, log?, config? })
 *       → { respond({pilotInstanceId, userId, userRole, userMessage, memoryLimit?}) }
 *
 * Operations explicitly NOT in this surface:
 *   - any memory mutation (the conversation layer reads only,
 *     through the companion reader);
 *   - any visibility / admissibility / supersession / retraction
 *     transition;
 *   - vault session opening;
 *   - streaming responses (the boundary guard bans `.stream(`,
 *     `messages.stream`, and `stream: true`);
 *   - tool / function calling (the boundary guard bans `tools`,
 *     `tool_choice`, `tool_use`, `tool_result`);
 *   - retries inside the runtime (the caller is expected to
 *     construct the SDK client with `maxRetries: 0`);
 *   - automatic memory creation from the model response;
 *   - transcript persistence;
 *   - HTTP servers, subprocesses, worker threads, scheduling.
 */

const { createConversationRuntime } = require('./runtime');

module.exports = {
  createConversationRuntime,
};
