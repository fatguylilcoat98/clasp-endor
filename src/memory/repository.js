'use strict';
/*
 * Memory-governance repository — the first audit-bundled surface.
 *
 * Two operations, both invoked through the ctx the caller receives
 * from withMemoryContext. The raw pg client is intentionally NOT
 * exposed; check-memory-boundary.js enforces that pg is imported only
 * by src/memory/client.js, so no caller can bypass the audit pairing
 * without modifying this file.
 *
 * Hard rules:
 *   - listVisibleMemories returns whatever RLS permits — never
 *     filters in JavaScript. Tenant isolation, owner/family/admin
 *     rules, and the password_locked vault-session gate are all
 *     enforced by the database.
 *   - insertPrivateMemory hard-codes visibility_level='private' and
 *     admissibility_state='admissible'. §11 of
 *     docs/governance/source-of-truth-memory-policy.md: every new
 *     memory is created private; broader visibility is an
 *     audit-bundled UPDATE, not an INSERT-time option. Visibility
 *     promotion is deferred (it needs UPDATE grants this PR does not
 *     add).
 *   - vault_id is forbidden in this surface — only password_locked
 *     memories ever carry it, and that visibility level is gated to a
 *     later GM.
 *   - Every op writes one audit row in the same transaction. If the
 *     audit INSERT throws, withMemoryContext ROLLBACKs both rows.
 */

const { insertAuditEvent, EVENT_TYPES } = require('./audit');

const VALID_PROVENANCE = new Set(['VERIFIED_FACT', 'USER_STATED', 'AI_INFERRED']);

async function listVisibleMemories(client, sessionCtx, options) {
  const opts = options || {};
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;

  const result = await client.query(
    'SELECT id, owning_user_id, content, provenance, visibility_level, '
      + 'admissibility_state, vault_id, active, created_at, updated_at '
      + 'FROM memory_store '
      + 'WHERE active = true '
      + 'ORDER BY created_at DESC '
      + 'LIMIT $1',
    [limit]
  );

  await insertAuditEvent(client, sessionCtx, {
    eventType: EVENT_TYPES.MEMORY_LIST,
    outcome: 'allowed',
    reason: `count=${result.rowCount}`,
  });

  return result.rows;
}

async function insertPrivateMemory(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('insertPrivateMemory: input is required');
  }
  const { content, provenance } = input;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('insertPrivateMemory: content must be a non-empty string');
  }
  if (!VALID_PROVENANCE.has(provenance)) {
    throw new Error(
      `insertPrivateMemory: provenance must be one of ${Array.from(VALID_PROVENANCE).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) '
      + "VALUES ($1, $2, $3, $4, 'private', 'admissible') "
      + 'RETURNING id, created_at',
    [sessionCtx.pilotInstanceId, sessionCtx.userId, content, provenance]
  );

  const memoryId = inserted.rows[0].id;

  await insertAuditEvent(client, sessionCtx, {
    eventType: EVENT_TYPES.MEMORY_CREATED,
    outcome: 'allowed',
    memoryId,
    targetUserId: sessionCtx.userId,
  });

  return {
    id: memoryId,
    created_at: inserted.rows[0].created_at,
  };
}

module.exports = { listVisibleMemories, insertPrivateMemory, VALID_PROVENANCE };
