'use strict';
/*
 * Companion structured JSON-line logger.
 *
 * Sibling of src/runtime/log.js — same shape, same reserved-core-field
 * discipline, no shared import. The companion module must not import
 * from src/runtime/ (separate boundary); the sibling pattern matches
 * how scripts/setup/log.js mirrors the runtime logger.
 *
 * Field discipline (enforced by review + the GM-19 reader unit test
 * that scans captured log output for sentinel content):
 *   - callers pass only safe scalars: counts, ids, role tokens, coarse
 *     error_class strings, fixed reason values.
 *   - memory content is NEVER logged.
 *   - persona text, profile fields, plaintext PINs, raw error messages
 *     never appear in a field.
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
