'use strict';
/*
 * Review-queue structured JSON-line logger.
 *
 * Sibling of every other module logger (runtime / setup / companion /
 * conversation / governance / actors). Same JSON-line shape, same
 * reserved core fields (ts, level, event, pid), no cross-package
 * imports.
 *
 * The review logger NEVER carries payload_summary, evidence_summary,
 * memory content, or the original user message. Only typed
 * metadata: pilot_instance_id, proposer_user_id, decision_intent_type,
 * decision_reason, queue_entry_id. The sentinel-scan adversarial test
 * (tests/governance/adversarial.test.js E6) asserts planted secrets
 * in payload_summary do NOT appear in captured logs.
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

function info(event, fields) { emit('info', event, fields); }
function warn(event, fields) { emit('warn', event, fields); }
function error(event, fields) { emit('error', event, fields); }

module.exports = { info, warn, error, emit, RESERVED_FIELDS };
