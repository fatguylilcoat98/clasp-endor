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
 *   - GM-18 (OQ-18.1): callers receive an OPAQUE handle, not the
 *     pg.Pool itself. The real pool is held in a module-scoped
 *     WeakMap keyed by the handle. Only `withMemoryContext` (via
 *     `_resolvePool`) can reach the real pool. A caller cannot call
 *     `.connect()` on the handle and bypass audit-bundling.
 *
 * Logging mirrors src/db/client.js: a structured (level, event, fields)
 * callback for idle-pool errors so a transient backend failure does
 * not become an unhandled 'error' event and crash the process.
 */

const { Pool } = require('pg');
const { describeErrorClass } = require('./errors');
const fs = require('fs');
const path = require('path');

// SSL configuration for Supabase connections. Only applied to
// non-local hosts — see src/db/client.js for the rationale.
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
    return {
      rejectUnauthorized: true,
      ca: ca,
    };
  } catch (err) {
    // Fall back to no SSL config when the cert file is missing.
    return undefined;
  }
}

// Internal handle class. Not exported from src/memory/index.js;
// constructed only by createMemoryPool. Frozen at construction so a
// caller cannot monkey-patch a `.connect` method onto it.
class MemoryPoolHandle {
  constructor() {
    Object.freeze(this);
  }
}

// Module-scoped WeakMap keyed by handle. The handle itself exposes
// nothing; the pool is reachable only via `_resolvePool` below, which
// is consumed by `transaction.js` and never re-exported through
// `index.js`.
const POOLS = new WeakMap();

function createMemoryPool(databaseUrl, options) {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('createMemoryPool: databaseUrl is required');
  }
  const opts = options || {};
  const log = opts.log || (() => {});
  const sslConfig = getSSLConfig(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslConfig,
    max: opts.max || 5,
    connectionTimeoutMillis: opts.connectionTimeoutMillis || 5000,
    idleTimeoutMillis: opts.idleTimeoutMillis || 10000,
    statement_timeout: opts.statementTimeoutMillis || 5000,
  });
  pool.on('error', (err) => {
    log('error', 'memory.pool.error', { error_class: describeErrorClass(err) });
  });
  const handle = new MemoryPoolHandle();
  POOLS.set(handle, pool);
  return handle;
}

async function closeMemoryPool(handle) {
  if (!handle) return;
  const pool = POOLS.get(handle);
  if (pool) {
    POOLS.delete(handle);
    await pool.end();
  }
}

// Internal — used only by transaction.js. NOT re-exported through
// src/memory/index.js. Accepts:
//   - a MemoryPoolHandle (production path) — looks up the real pool.
//   - any other object with a `.connect` function (test mocks) —
//     passes through. This is the seam unit tests use; it does not
//     widen the production surface because callers outside src/memory/
//     cannot import pg (boundary guard) and cannot construct a
//     pg-compatible pool literal that would survive the lylo_app
//     LOGIN role's auth.
function _resolvePool(handleOrMock) {
  if (handleOrMock instanceof MemoryPoolHandle) {
    return POOLS.get(handleOrMock);
  }
  if (handleOrMock && typeof handleOrMock.connect === 'function') {
    return handleOrMock;
  }
  return null;
}

function _isMemoryPoolHandle(value) {
  return value instanceof MemoryPoolHandle;
}

module.exports = {
  createMemoryPool,
  closeMemoryPool,
  _resolvePool,
  _isMemoryPoolHandle,
};
