'use strict';
/*
 * Structured JSON-line logger.
 *
 * Every entry is one line of JSON with the core fields ts (ISO 8601),
 * level, event, and pid, plus any caller-supplied fields. Output goes
 * to stdout; there is no level routing, no shipping, no dependencies.
 *
 * Field discipline (enforced by review, documented in
 * docs/governance/runtime-boundary.md):
 *   - callers pass only safe scalars and small objects — a coarse
 *     error_class, state names, port integers, counts, fixed reason
 *     strings;
 *   - the database connection string, persona text, profile content,
 *     and any secret never appear in a field;
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
