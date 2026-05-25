'use strict';
/*
 * Test-door ring buffer of recent chat interactions.
 *
 * Process-local, in-memory only. No DB write, no audit row, no new
 * EVENT_TYPES, no persistence across restart. The admin panel reads
 * this and only this; the runtime substrate is not consulted.
 *
 * Stored fields are metadata only — no user message text, no model
 * response text, no user IDs of other users, no persona content. The
 * web layer is the only consumer; tests assert non-leakage.
 */

const DEFAULT_CAPACITY = 50;
const MAX_REASON_LEN = 80;
const MAX_OUTCOME_LEN = 32;
const MAX_DECISION_LEN = 32;

function safeString(value, maxLen) {
  if (typeof value !== 'string') return null;
  if (value.length === 0) return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function safeNumber(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function createRecentBuffer(options) {
  const opts = options || {};
  const capacity = Number.isInteger(opts.capacity) && opts.capacity > 0
    ? opts.capacity
    : DEFAULT_CAPACITY;

  const entries = [];

  function record(input) {
    if (!input || typeof input !== 'object') return;
    const entry = Object.freeze({
      ts: new Date().toISOString(),
      userRole: safeString(input.userRole, 16),
      outcome: safeString(input.outcome, MAX_OUTCOME_LEN),
      decision: safeString(input.decision, MAX_DECISION_LEN),
      reason: safeString(input.reason, MAX_REASON_LEN),
      memoryCount: safeNumber(input.memoryCount),
      responseChars: safeNumber(input.responseChars),
      errorClass: safeString(input.errorClass, 32),
    });
    entries.push(entry);
    while (entries.length > capacity) entries.shift();
  }

  function list() {
    return entries.slice().reverse();
  }

  function size() {
    return entries.length;
  }

  return Object.freeze({ record, list, size, capacity });
}

module.exports = { createRecentBuffer, DEFAULT_CAPACITY };
