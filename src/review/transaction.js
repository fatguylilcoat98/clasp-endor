'use strict';
/*
 * withReviewContext — the only entry point through which the review
 * module talks to the database.
 *
 * Mirrors src/memory/transaction.js withMemoryContext:
 *   1. Validates the session context (UUID/role) BEFORE any DB work.
 *   2. Resolves the pool handle.
 *   3. BEGIN.
 *   4. Binds three session vars (app.pilot_instance_id, app.user_id,
 *      app.user_role) via SELECT set_config($1, $2, true) — the
 *      parameter-safe equivalent of SET LOCAL. Reverts at
 *      COMMIT/ROLLBACK; never leaks across pooled connections.
 *   5. Invokes the caller's fn(ctx) where ctx exposes the
 *      stageReviewItem function (and ONLY that function — no raw
 *      pg client surface).
 *   6. COMMITs on resolve; ROLLBACKs on any throw.
 *   7. Releases the client back to the pool.
 *
 * pg-shaped errors thrown inside fn(ctx) are wrapped into
 * ReviewRepositoryError (mirrors GM-18's MemoryRepositoryError
 * sanitization). Caller-contract validation errors pass through
 * unchanged.
 *
 * Per OQ-17.10 and §3 of governance-runtime-boundary.md there is no
 * app.session_id. Per OQ-23.7, SELECT visibility is narrowed to
 * proposer + admin via the RLS policies — those policies read the
 * same app.* session variables withMemoryContext binds.
 */

const { _resolvePool } = require('./client');
const { ReviewRepositoryError, isPgError, describeErrorClass } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

function validateContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('withReviewContext: context object is required');
  }
  const { pilotInstanceId, userId, userRole } = ctx;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('withReviewContext: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('withReviewContext: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `withReviewContext: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
}

const {
  stageReviewItem,
  listPendingReviewItems,
  inspectReviewItem,
  recordReviewDecision,
} = require('./repository');

function buildCtx(client, sessionCtx) {
  return {
    pilotInstanceId: sessionCtx.pilotInstanceId,
    userId: sessionCtx.userId,
    userRole: sessionCtx.userRole,
    stageReviewItem: (input) => stageReviewItem(client, sessionCtx, input),
    // GM-24: review-decision read + write.
    listPendingReviewItems: (options) => listPendingReviewItems(client, sessionCtx, options),
    inspectReviewItem: (queueId) => inspectReviewItem(client, sessionCtx, queueId),
    recordReviewDecision: (input) => recordReviewDecision(client, sessionCtx, input),
  };
}

function sanitizeError(err) {
  if (err && err.name === 'ReviewRepositoryError') return err;
  if (isPgError(err)) {
    return new ReviewRepositoryError(
      describeErrorClass(err),
      'review operation failed'
    );
  }
  return err;
}

async function withReviewContext(poolOrHandle, sessionCtx, fn) {
  const pool = _resolvePool(poolOrHandle);
  if (!pool) {
    throw new Error(
      'withReviewContext: pool must be a ReviewPoolHandle obtained via createReviewQueuePool'
    );
  }
  if (typeof fn !== 'function') {
    throw new Error('withReviewContext: callback function is required');
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

module.exports = { withReviewContext, UUID_RE, VALID_ROLES };
