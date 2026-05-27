'use strict';
/*
 * withMemoryContext — the only entry point through which the memory
 * module talks to the database.
 *
 * Every memory-governance op (read or write) must run inside this
 * helper. The helper:
 *   1. Validates the session context (UUID/role) BEFORE any DB work.
 *   2. Resolves the pool handle to a real pg.Pool (production) or
 *      passes through a test-mock pool. Production callers receive a
 *      MemoryPoolHandle from createMemoryPool and cannot reach the
 *      underlying pool themselves (OQ-18.1).
 *   3. Acquires a client from the pool.
 *   4. BEGIN.
 *   5. Binds the three session vars (app.pilot_instance_id,
 *      app.user_id, app.user_role) via SELECT set_config($1, $2, true).
 *      set_config(..., is_local=true) is the parameter-safe equivalent
 *      of SET LOCAL — it reverts at COMMIT/ROLLBACK and never escapes
 *      the transaction, so a connection returned to the pool carries
 *      no leaked session vars.
 *   6. Invokes the caller's fn(ctx) where ctx exposes the audit and
 *      repository functions — never the raw pg client.
 *   7. COMMITs on resolve; ROLLBACKs on any throw.
 *   8. Releases the client back to the pool.
 *
 * GM-18 error sanitization (OQ-18.2): any pg-originated error thrown
 * inside fn(ctx) is wrapped into a MemoryRepositoryError carrying only
 * `name`, `error_class` (= SQLSTATE), and a fixed safe `message`. The
 * caller never sees pg's `detail`, `where`, `routine`, `parameters`,
 * or `internalQuery` — any of which can echo memory content. Caller-
 * contract validation errors (UUID/role/content/etc.) pass through
 * unchanged (OQ-18.7).
 *
 * Per OQ-17.10 there is no app.session_id. The vault unlock model is
 * row-state-based (OQ-14.3): visibility of password_locked memories
 * depends on the existence of an unexpired non-revoked
 * memory_vault_sessions row whose user_id matches app.user_id, not on
 * a session-variable id.
 */

const { _resolvePool } = require('./client');
const { MemoryRepositoryError, isPgError, describeErrorClass } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

function validateContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('withMemoryContext: context object is required');
  }
  const { pilotInstanceId, userId, userRole } = ctx;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('withMemoryContext: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('withMemoryContext: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `withMemoryContext: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
}

const { listVisibleMemories, listMemoriesForInspector, listRecentAuditEvents, insertPrivateMemory, insertSharedMemory, promoteMemoryToVerified, findWorkingMemoriesByContent, findActiveMemoriesContaining, deactivateMemory } = require('./repository');

function buildCtx(client, sessionCtx) {
  return {
    pilotInstanceId: sessionCtx.pilotInstanceId,
    userId: sessionCtx.userId,
    userRole: sessionCtx.userRole,
    listVisibleMemories: (opts) => listVisibleMemories(client, sessionCtx, opts),
    listMemoriesForInspector: (opts) => listMemoriesForInspector(client, sessionCtx, opts),
    listRecentAuditEvents: (opts) => listRecentAuditEvents(client, sessionCtx, opts),
    insertPrivateMemory: (input) => insertPrivateMemory(client, sessionCtx, input),
    insertSharedMemory: (input) => insertSharedMemory(client, sessionCtx, input),
    promoteMemoryToVerified: (memoryId, reason) => promoteMemoryToVerified(client, sessionCtx, memoryId, reason),
    findWorkingMemoriesByContent: (contentArray) => findWorkingMemoriesByContent(client, sessionCtx, contentArray),
    findActiveMemoriesContaining: (searchText) => findActiveMemoriesContaining(client, sessionCtx, searchText),
    deactivateMemory: (memoryId, reason) => deactivateMemory(client, sessionCtx, memoryId, reason),
  };
}

// Wrap a pg error into MemoryRepositoryError so caller logs never see
// pg's detail/where/routine/parameters. Validation errors thrown by
// the memory module itself (Error with no `.code` SQLSTATE) pass
// through unchanged.
function sanitizeError(err) {
  if (err && err.name === 'MemoryRepositoryError') return err;
  if (isPgError(err)) {
    return new MemoryRepositoryError(
      describeErrorClass(err),
      'memory operation failed'
    );
  }
  return err;
}

async function withMemoryContext(poolOrHandle, sessionCtx, fn) {
  const pool = _resolvePool(poolOrHandle);
  if (!pool) {
    throw new Error(
      'withMemoryContext: pool must be a MemoryPoolHandle obtained via createMemoryPool'
    );
  }
  if (typeof fn !== 'function') {
    throw new Error('withMemoryContext: callback function is required');
  }
  validateContext(sessionCtx);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.pilot_instance_id',
        sessionCtx.pilotInstanceId,
      ]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.user_id',
        sessionCtx.userId,
      ]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.user_role',
        sessionCtx.userRole,
      ]);
      const ctx = buildCtx(client, sessionCtx);
      const result = await fn(ctx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the transaction is already gone; nothing to roll back */
      }
      throw sanitizeError(err);
    }
  } finally {
    client.release();
  }
}

module.exports = { withMemoryContext, UUID_RE, VALID_ROLES };
