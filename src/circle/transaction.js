'use strict';
/*
 * withCircleContext — the only entry point through which the circle
 * module talks to the database. Mirrors withMemoryContext.
 *
 * Every circle op runs inside this helper. It:
 *   1. Validates the session context (UUID/role).
 *   2. Acquires a client from the resolved pool.
 *   3. BEGIN.
 *   4. Binds app.pilot_instance_id / app.user_id / app.user_role
 *      via SELECT set_config($1, $2, true) — parameter-safe
 *      SET LOCAL equivalent that reverts at COMMIT/ROLLBACK.
 *   5. Invokes fn(ctx) where ctx exposes the circle repository
 *      functions — never the raw pg client.
 *   6. COMMITs on resolve; ROLLBACKs on any throw.
 *   7. Releases the client back to the pool.
 */

const { _resolvePool } = require('./client');
const {
  insertCircleContact,
  listCircleContactsForSenior,
  setCircleContactScope,
  lookupUserByEmail,
} = require('./repository');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

function validateContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('withCircleContext: context object is required');
  }
  const { pilotInstanceId, userId, userRole } = ctx;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('withCircleContext: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('withCircleContext: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `withCircleContext: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
}

function buildCtx(client, sessionCtx) {
  return {
    pilotInstanceId: sessionCtx.pilotInstanceId,
    userId: sessionCtx.userId,
    userRole: sessionCtx.userRole,
    insertCircleContact: (input) => insertCircleContact(client, sessionCtx, input),
    listCircleContactsForSenior: () => listCircleContactsForSenior(client, sessionCtx),
    setCircleContactScope: (id, visibilityLevels) =>
      setCircleContactScope(client, sessionCtx, id, visibilityLevels),
    lookupUserByEmail: (email) => lookupUserByEmail(client, sessionCtx, email),
  };
}

async function withCircleContext(poolOrHandle, sessionCtx, fn) {
  const pool = _resolvePool(poolOrHandle);
  if (!pool) {
    throw new Error(
      'withCircleContext: pool must be a CirclePoolHandle obtained via createCirclePool'
    );
  }
  if (typeof fn !== 'function') {
    throw new Error('withCircleContext: callback function is required');
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
        /* transaction already gone */
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { withCircleContext, UUID_RE, VALID_ROLES };
