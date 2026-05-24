'use strict';
/*
 * Review-queue database client.
 *
 * The only file in src/review/ allowed to import pg (enforced by
 * scripts/ci/check-review-boundary.js). Owns the connection pool
 * that connects as the lylo_app DB role via the same
 * LYLO_APP_DATABASE_URL the memory module uses.
 *
 * Defense-in-depth contract (see docs/governance/review-queue-runtime-boundary.md):
 *   - lylo_app is subject to RLS (no BYPASSRLS); every INSERT goes
 *     through the WITH CHECK policy that enforces tenant-scope and
 *     proposer-impersonation prevention.
 *   - lylo_app has SELECT + INSERT on governance_review_queue only;
 *     no UPDATE / DELETE grants exist for any role.
 *   - The pool returned is an opaque handle (mirrors the GM-18
 *     MemoryPoolHandle pattern). Callers cannot reach the underlying
 *     pg.Pool through it.
 *
 * Logging mirrors src/memory/client.js: a structured (level, event,
 * fields) callback for idle-pool errors so a transient backend
 * failure does not become an unhandled 'error' event and crash the
 * process.
 */

const { Pool } = require('pg');
const { describeErrorClass } = require('./errors');

// Internal handle class. Not exported from src/review/index.js;
// constructed only by createReviewQueuePool. Frozen at construction
// so a caller cannot monkey-patch a .connect method onto it.
class ReviewPoolHandle {
  constructor() {
    Object.freeze(this);
  }
}

// Module-scoped WeakMap keyed by handle. The handle itself exposes
// nothing; the pool is reachable only via _resolvePool below.
const POOLS = new WeakMap();

function createReviewQueuePool(databaseUrl, options) {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('createReviewQueuePool: databaseUrl is required');
  }
  const opts = options || {};
  const log = opts.log || (() => {});
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.max || 5,
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000,
    idleTimeoutMillis: opts.idleTimeoutMillis || 10000,
    statement_timeout: opts.statementTimeoutMillis || 5000,
  });
  pool.on('error', (err) => {
    log('error', 'review.pool.error', { error_class: describeErrorClass(err) });
  });
  const handle = new ReviewPoolHandle();
  POOLS.set(handle, pool);
  return handle;
}

async function closeReviewQueuePool(handle) {
  if (!handle) return;
  const pool = POOLS.get(handle);
  if (pool) {
    POOLS.delete(handle);
    await pool.end();
  }
}

// Internal — used only by transaction.js. NOT re-exported through
// src/review/index.js. Accepts a ReviewPoolHandle (production path)
// or any duck-typed object with a `.connect` function (test mocks).
function _resolvePool(handleOrMock) {
  if (handleOrMock instanceof ReviewPoolHandle) {
    return POOLS.get(handleOrMock);
  }
  if (handleOrMock && typeof handleOrMock.connect === 'function') {
    return handleOrMock;
  }
  return null;
}

module.exports = {
  createReviewQueuePool,
  closeReviewQueuePool,
  _resolvePool,
};
