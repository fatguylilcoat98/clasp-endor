'use strict';
/*
 * Database client.
 *
 * Wraps a single pg connection pool for the runtime configuration
 * loader. The pool performs short, read-only queries at boot.
 *
 * The connection string is a secret: it is never logged, and database
 * error detail is reduced to a coarse, non-sensitive class before
 * logging. This module is the only place that imports pg.
 */

const { Pool } = require('pg');

// Bounded connection backoff: 4 attempts, waiting 1s, 2s, 4s, 8s after
// a failed attempt. Exhausted attempts are fail-closed.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reduce a database error to a coarse, non-sensitive class for logging.
// Never returns the connection string, credentials, or query text.
function describeDbError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'error';
}

// Create the connection pool. The connection string is held only by the
// pool object; it is never logged. An optional structured `log`
// callback receives `(level, event, fields)` for any idle-pool error,
// so a transient backend failure does not become an unhandled 'error'
// event (and crash the process).
function createPool(databaseUrl, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
  });
  pool.on('error', (err) => {
    log('error', 'db.pool.error', { error_class: describeDbError(err) });
  });
  return pool;
}

/*
 * Attempt to reach the database, retrying with bounded backoff.
 *   pool    - the connection pool
 *   options - { delaysMs, log }
 *
 * `log` is the structured-logger callback (level, event, fields).
 * Returns { connected, attempts }.
 */
async function connectWithRetry(pool, options) {
  const opts = options || {};
  const delays = opts.delaysMs || RETRY_DELAYS_MS;
  const log = opts.log || (() => {});
  for (let i = 0; i < delays.length; i++) {
    try {
      await pool.query('SELECT 1');
      return { connected: true, attempts: i + 1 };
    } catch (err) {
      log('warn', 'db.connect.attempt_failed', {
        attempt: i + 1,
        max: delays.length,
        error_class: describeDbError(err),
      });
      await sleep(delays[i]);
    }
  }
  return { connected: false, attempts: delays.length };
}

// A single liveness probe. Returns true when the database is reachable.
async function pingDatabase(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// Close the pool, draining in-flight queries.
async function closePool(pool) {
  if (pool) await pool.end();
}

module.exports = {
  createPool,
  connectWithRetry,
  pingDatabase,
  closePool,
  describeDbError,
  RETRY_DELAYS_MS,
};
