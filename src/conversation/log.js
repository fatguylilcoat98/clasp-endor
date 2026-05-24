'use strict';
/*
 * Conversation structured JSON-line logger.
 *
 * Sibling of src/runtime/log.js, scripts/setup/log.js, and
 * src/companion/log.js. Same JSON-line shape, same reserved core
 * fields (ts, level, event, pid), no cross-package imports. The
 * conversation module must not import from src/runtime/, src/db/,
 * src/memory/, or src/companion/log.js (separate boundaries).
 *
 * Field discipline (the central GM-20 privacy assertion is the
 * sentinel-scan unit test, which plants secret strings in both a
 * memory row and the model response and asserts neither appears in
 * any captured log line):
 *   - callers pass only safe scalars: counts, ids, role tokens,
 *     coarse error_class strings, fixed reason values.
 *   - memory content, the user message, and the model response are
 *     NEVER logged.
 *   - the model SDK API key never appears in a field.
 *   - core fields (ts, level, event, pid) are reserved and cannot be
 *     overridden by caller-supplied fields.
 */

const RESERVED_FIELDS = new Set(['ts', 'level', 'event', 'pid']);

function emit(level, event, fields) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
  };
  if (fields) {
    for (const key of Object.keys(fields)) {
      if (!RESERVED_FIELDS.has(key)) {
        entry[key] = fields[key];
      }
    }
  }
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function info(event, fields) {
  emit('info', event, fields);
}

function warn(event, fields) {
  emit('warn', event, fields);
}

function error(event, fields) {
  emit('error', event, fields);
}

module.exports = { info, warn, error, emit, RESERVED_FIELDS };
