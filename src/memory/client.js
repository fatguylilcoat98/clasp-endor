'use strict';
/*
 * Memory-governance database client.
 *
 * The only file in src/memory/ allowed to import pg (enforced by
 * scripts/ci/check-memory-boundary.js). Owns the connection pool that
 * connects as the lylo_app DB role via LYLO_APP_DATABASE_URL.
 *
 * Defense-in-depth contract (see docs/governance/memory-runtime-boundary.md):
 *   - lylo_app is subject to RLS (no BYPASSRLS). Every read is
 *     narrowed by the GM-15 policies once the per-request session vars
 *     are bound inside the transaction.
 *   - lylo_app has no grants on the four config tables nor on users
 *     for write paths; defense in depth for the runtime/memory split.
 *
 * Logging mirrors src/db/client.js: a structured (level, event, fields)
 * callback for idle-pool errors so a transient backend failure does
 * not become an unhandled 'error' event and crash the process.
 */

const { Pool } = require('pg');

function describeDbError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'error';
}

function createMemoryPool(databaseUrl, options) {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('createMemoryPool: databaseUrl is required');
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
    log('error', 'memory.pool.error', { error_class: describeDbError(err) });
  });
  return pool;
}

async function closeMemoryPool(pool) {
  if (pool) await pool.end();
}

module.exports = { createMemoryPool, closeMemoryPool, describeDbError };
