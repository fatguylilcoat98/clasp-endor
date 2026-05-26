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
 *     audit-bundled write, not an INSERT-time option. Visibility
 *     promotion is deferred (it needs UPDATE grants this PR does not
 *     add).
 *   - vault_id is forbidden in this surface — only password_locked
 *     memories ever carry it, and that visibility level is gated to a
 *     later GM.
 *   - GM-18 (OQ-18.4 / OQ-18.5): content is capped at
 *     MAX_CONTENT_LENGTH bytes (UTF-8). The rejection error reports
 *     the length and the limit but does NOT echo the content.
 *   - Every op writes one audit row in the same transaction. If the
 *     audit INSERT throws, withMemoryContext ROLLBACKs both rows.
 */

const { insertAuditEvent, EVENT_TYPES } = require('./audit');

const VALID_PROVENANCE = new Set(['VERIFIED_FACT', 'USER_STATED', 'AI_INFERRED']);
const VALID_MEMORY_STATUS = new Set(['WORKING_ACTIVE', 'GOVERNANCE_PENDING', 'VERIFIED', 'SUPERSEDED']);

// Maximum content length, in UTF-8 bytes. Caps an individual memory at
// 64 KiB — generous for any reasonable supported-person statement and
// conservative against DoS via oversized inserts or audit-log bloat.
const MAX_CONTENT_LENGTH = 65536;

async function listVisibleMemories(client, sessionCtx, options) {
  const opts = options || {};
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;

  const result = await client.query(
    'SELECT id, owning_user_id, content, provenance, visibility_level, '
      + 'admissibility_state, memory_status, vault_id, active, created_at, updated_at '
      + 'FROM memory_store '
      + 'WHERE active = true AND memory_status IN ($2, $3) '
      + 'ORDER BY created_at DESC '
      + 'LIMIT $1',
    [limit, 'WORKING_ACTIVE', 'VERIFIED']
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
  const { content, provenance, memoryStatus } = input;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('insertPrivateMemory: content must be a non-empty string');
  }
  // Length check is in UTF-8 bytes (not JS code units) so the cap is
  // independent of the script's encoding. The error message reports
  // only the length and the limit — never the content.
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_CONTENT_LENGTH) {
    throw new Error(
      `insertPrivateMemory: content exceeds maximum length (${contentBytes} > ${MAX_CONTENT_LENGTH} bytes)`
    );
  }
  if (!VALID_PROVENANCE.has(provenance)) {
    throw new Error(
      `insertPrivateMemory: provenance must be one of ${Array.from(VALID_PROVENANCE).join(', ')}`
    );
  }

  const status = memoryStatus || 'WORKING_ACTIVE';
  if (!VALID_MEMORY_STATUS.has(status)) {
    throw new Error(
      `insertPrivateMemory: memoryStatus must be one of ${Array.from(VALID_MEMORY_STATUS).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO memory_store '
      + '(pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state, memory_status) '
      + "VALUES ($1, $2, $3, $4, 'private', 'admissible', $5) "
      + 'RETURNING id, created_at',
    [sessionCtx.pilotInstanceId, sessionCtx.userId, content, provenance, status]
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

async function promoteMemoryToVerified(client, sessionCtx, memoryId, reason) {
  if (typeof memoryId !== 'string') {
    throw new Error('promoteMemoryToVerified: memoryId must be a string');
  }

  // Update memory status to VERIFIED
  await client.query(
    `UPDATE memory_store
     SET memory_status = 'VERIFIED', updated_at = NOW()
     WHERE id = $1 AND pilot_instance_id = $2 AND owning_user_id = $3`,
    [memoryId, sessionCtx.pilotInstanceId, sessionCtx.userId]
  );

  // Log the promotion
  await insertAuditEvent(client, sessionCtx, {
    eventType: EVENT_TYPES.MEMORY_UPDATED,
    outcome: 'allowed',
    memoryId,
    targetUserId: sessionCtx.userId,
    reason: reason || 'promoted to VERIFIED'
  });

  return { id: memoryId, promotedAt: new Date() };
}

async function findWorkingMemoriesByContent(client, sessionCtx, contentArray) {
  if (!Array.isArray(contentArray) || contentArray.length === 0) {
    return [];
  }

  const placeholders = contentArray.map((_, i) => `$${i + 3}`).join(', ');
  const query = `
    SELECT id, content, created_at
    FROM memory_store
    WHERE pilot_instance_id = $1
      AND owning_user_id = $2
      AND content IN (${placeholders})
      AND memory_status = 'WORKING_ACTIVE'
      AND active = true
    ORDER BY created_at DESC
  `;

  const params = [sessionCtx.pilotInstanceId, sessionCtx.userId, ...contentArray];
  const result = await client.query(query, params);
  return result.rows;
}

async function findActiveMemoriesContaining(client, sessionCtx, searchText) {
  if (!searchText || typeof searchText !== 'string') {
    return [];
  }

  const query = `
    SELECT id, content, created_at, memory_status
    FROM memory_store
    WHERE pilot_instance_id = $1
      AND owning_user_id = $2
      AND content ILIKE $3
      AND active = true
    ORDER BY created_at DESC
  `;

  const params = [sessionCtx.pilotInstanceId, sessionCtx.userId, `%${searchText}%`];
  const result = await client.query(query, params);
  return result.rows;
}

async function deactivateMemory(client, sessionCtx, memoryId, reason) {
  if (!memoryId || typeof memoryId !== 'string') {
    throw new Error('deactivateMemory: memoryId is required');
  }

  if (!reason || typeof reason !== 'string') {
    throw new Error('deactivateMemory: reason is required');
  }

  const query = `
    UPDATE memory_store
    SET active = false,
        memory_status = 'SUPERSEDED',
        updated_at = NOW()
    WHERE pilot_instance_id = $1
      AND owning_user_id = $2
      AND id = $3
      AND active = true
    RETURNING id, updated_at
  `;

  const params = [sessionCtx.pilotInstanceId, sessionCtx.userId, memoryId];
  const result = await client.query(query, params);

  if (result.rows.length === 0) {
    throw new Error('deactivateMemory: memory not found or already deactivated');
  }

  // Audit the deactivation. The function signature is
  // insertAuditEvent(client, sessionCtx, fields) — eventType lives
  // INSIDE the fields object, not as a positional argument.
  await insertAuditEvent(client, sessionCtx, {
    eventType: EVENT_TYPES.MEMORY_UPDATED,
    outcome: 'allowed',
    memoryId,
    targetUserId: sessionCtx.userId,
    reason: `deactivated (active->false, status->SUPERSEDED): ${reason}`,
  });

  return { id: memoryId, deactivatedAt: result.rows[0].updated_at };
}

module.exports = {
  listVisibleMemories,
  insertPrivateMemory,
  promoteMemoryToVerified,
  findWorkingMemoriesByContent,
  findActiveMemoriesContaining,
  deactivateMemory,
  VALID_PROVENANCE,
  MAX_CONTENT_LENGTH,
};
