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
 * Event vocabulary is application-pinned (the schema's event_type is
 * freeform TEXT). The set below is the GM-17 first surface; future
 * memory-governance ops will append additional events.
 */

const EVENT_TYPES = Object.freeze({
  MEMORY_CREATED: 'memory.created',
  MEMORY_LIST: 'memory.list',
});

const OUTCOMES = Object.freeze(['allowed', 'denied', 'masked', 'partial']);

async function insertAuditEvent(client, sessionCtx, fields) {
  if (!fields || typeof fields !== 'object') {
    throw new Error('insertAuditEvent: fields object is required');
  }
  const { eventType, outcome, targetUserId, memoryId, reason } = fields;
  if (typeof eventType !== 'string' || eventType.trim() === '') {
    throw new Error('insertAuditEvent: eventType is required');
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

module.exports = { insertAuditEvent, EVENT_TYPES, OUTCOMES };
