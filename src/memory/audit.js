'use strict';
/*
 * Internal audit-event INSERT.
 *
 * Not exported from src/memory/index — only the repository functions
 * call it, inside the same transaction as the sensitive op they're
 * pairing it with. If the audit INSERT throws, the surrounding
 * withMemoryContext catches it and ROLLBACKs both rows (atomicity is
 * the whole point of bundling memory + audit in one transaction).
 *
 * GM-18 vocabulary lock (OQ-18.3): `eventType` must be one of the
 * values in EVENT_TYPES. The schema's `event_type` column is
 * freeform TEXT, so a typo would otherwise pollute the audit log.
 * Adding a new event type becomes a deliberate edit to the constants
 * below.
 */

// Locked vocabulary. Each value is the audit row's event_type. Widening
// requires a paired ALLOWED_UPDATE_COLUMNS edit in repository.js so the
// memory-boundary guard stays honest.
//
//   memory.created — INSERT into memory_store (createMemory path).
//   memory.list    — SELECT into the per-request visibility list.
//   memory.updated — UPDATE to a controlled subset of memory_store
//                    columns: memory_status (WORKING_ACTIVE → VERIFIED
//                    promotion) and active (deactivation/supersession
//                    after a user correction). Content, provenance,
//                    pilot/owner identity remain immutable per the
//                    db/migrations/015 trigger.
const EVENT_TYPES = Object.freeze({
  MEMORY_CREATED: 'memory.created',
  MEMORY_LIST: 'memory.list',
  MEMORY_UPDATED: 'memory.updated',
});

const ALLOWED_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

const OUTCOMES = Object.freeze(['allowed', 'denied', 'masked', 'partial']);

async function insertAuditEvent(client, sessionCtx, fields) {
  if (!fields || typeof fields !== 'object') {
    throw new Error('insertAuditEvent: fields object is required');
  }
  const { eventType, outcome, targetUserId, memoryId, reason } = fields;
  if (typeof eventType !== 'string' || !ALLOWED_EVENT_TYPES.has(eventType)) {
    throw new Error(
      `insertAuditEvent: eventType must be one of ${Array.from(ALLOWED_EVENT_TYPES).join(', ')}`
    );
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`insertAuditEvent: outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  await client.query(
    'INSERT INTO governance_audit_log '
      + '(pilot_instance_id, memory_id, target_user_id, event_type, actor_user_id, actor_role, reason, outcome) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      sessionCtx.pilotInstanceId,
      memoryId || null,
      targetUserId || null,
      eventType,
      sessionCtx.userId,
      sessionCtx.userRole,
      reason || null,
      outcome,
    ]
  );
}

module.exports = { insertAuditEvent, EVENT_TYPES, ALLOWED_EVENT_TYPES, OUTCOMES };
