'use strict';
/*
 * Circle-contacts database client.
 *
 * The only file in src/circle/ allowed to import pg (enforced by
 * scripts/ci/check-circle-boundary.js). Owns the connection pool
 * that connects as the lylo_app DB role via LYLO_APP_DATABASE_URL.
 *
 * Mirrors src/memory/client.js's posture:
 *   - lylo_app is subject to RLS (no BYPASSRLS). Every read and
 *     write is narrowed by RLS policies on circle_contacts after the
 *     per-request session vars are bound inside the transaction.
 *   - Callers receive an OPAQUE handle (CirclePoolHandle), not the
 *     pg.Pool itself. The real pool is held in a module-scoped
 *     WeakMap keyed by the handle. Only `withCircleContext`
 *     (via `_resolvePool`) can reach the real pool.
 *
 * Logging mirrors src/db/client.js: a structured (level, event, fields)
 * callback for idle-pool errors so a transient backend failure does
 * not become an unhandled 'error' event and crash the process.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function isLocalConnectionUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) return false;
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function getSSLConfig(databaseUrl) {
  if (isLocalConnectionUrl(databaseUrl)) return undefined;
  const caCertPath = process.env.DB_CA_CERT_PATH || path.join(__dirname, '..', '..', 'certs', 'supabase-ca.crt');
  try {
    const ca = fs.readFileSync(caCertPath, 'utf8');
    return { rejectUnauthorized: true, ca };
  } catch {
    return undefined;
  }
}

function describeErrorClass(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'error';
}

class CirclePoolHandle {
  constructor() {
    Object.freeze(this);
  }
}

const POOLS = new WeakMap();

function createCirclePool(databaseUrl, options) {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('createCirclePool: databaseUrl is required');
  }
  const opts = options || {};
  const log = opts.log || (() => {});
  const sslConfig = getSSLConfig(databaseUrl);
  // Safe host:port for error logs. Never includes user/password/path.
  let dbHost = 'unknown';
  try {
    const u = new URL(databaseUrl);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    dbHost = `${h}:${u.port || '5432'}`;
  } catch { /* malformed URL — the Pool constructor will surface it */ }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslConfig,
    max: opts.max || 3,
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000,
    idleTimeoutMillis: opts.idleTimeoutMillis || 10000,
    statement_timeout: opts.statementTimeoutMillis || 5000,
  });
  pool.on('error', (err) => {
    log('error', 'circle.pool.error', {
      error_class: describeErrorClass(err),
      db_host: dbHost,
      address: err && err.address,
      port: err && err.port,
    });
  });
  const handle = new CirclePoolHandle();
  POOLS.set(handle, pool);
  return handle;
}

async function closeCirclePool(handle) {
  if (!handle) return;
  const pool = POOLS.get(handle);
  if (pool) {
    POOLS.delete(handle);
    await pool.end();
  }
}

function _resolvePool(handleOrMock) {
  if (handleOrMock instanceof CirclePoolHandle) {
    return POOLS.get(handleOrMock);
  }
  if (handleOrMock && typeof handleOrMock.connect === 'function') {
    return handleOrMock;
  }
  return null;
}

module.exports = {
  createCirclePool,
  closeCirclePool,
  _resolvePool,
};
