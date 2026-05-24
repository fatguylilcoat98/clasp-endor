'use strict';
/*
 * withMemoryContext — the only entry point through which the memory
 * module talks to the database.
 *
 * Every memory-governance op (read or write) must run inside this
 * helper. The helper:
 *   1. Acquires a client from the lylo_app pool.
 *   2. BEGIN.
 *   3. Binds the three session vars (app.pilot_instance_id,
 *      app.user_id, app.user_role) via SELECT set_config($1, $2, true).
 *      set_config(..., is_local=true) is the parameter-safe equivalent
 *      of SET LOCAL — it reverts at COMMIT/ROLLBACK and never escapes
 *      the transaction, so a connection returned to the pool carries
 *      no leaked session vars.
 *   4. Invokes the caller's fn(ctx) where ctx exposes the audit and
 *      repository functions — never the raw pg client.
 *   5. COMMITs on resolve; ROLLBACKs on any throw.
 *   6. Releases the client back to the pool.
 *
 * Each session var is required. A blank/missing pilotInstanceId,
 * userId, or userRole throws BEFORE any DB work. This prevents
 * silently-denying queries from getting interpreted as "the user has
 * no memories."
 *
 * Per OQ-17.10 there is no app.session_id. The vault unlock model is
 * row-state-based (OQ-14.3): visibility of password_locked memories
 * depends on the existence of an unexpired non-revoked
 * memory_vault_sessions row whose user_id matches app.user_id, not on
 * a session-variable id.
 */

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

const { listVisibleMemories, insertPrivateMemory } = require('./repository');

function buildCtx(client, sessionCtx) {
  return {
    pilotInstanceId: sessionCtx.pilotInstanceId,
    userId: sessionCtx.userId,
    userRole: sessionCtx.userRole,
    listVisibleMemories: (opts) => listVisibleMemories(client, sessionCtx, opts),
    insertPrivateMemory: (input) => insertPrivateMemory(client, sessionCtx, input),
  };
}

async function withMemoryContext(pool, sessionCtx, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('withMemoryContext: pool must be a pg.Pool');
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
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { withMemoryContext, UUID_RE, VALID_ROLES };
