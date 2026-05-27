'use strict';
/*
 * Test-door web boot entry.
 *
 * Composes the test-door HTTP server: parse env, build the
 * Anthropic-wired chat chain via src/web/wiring, build the Supabase
 * Auth client + identity resolver, build the recent ring buffer,
 * build the session codec, mount the server.
 *
 * Hard rules:
 *   - This entry is for the disposable clasp-endor test instance only.
 *     It is gated by LYLO_WEB_MODE=true.
 *   - Each verified user gets a distinct public.users row (via
 *     Supabase Auth + src/web/identity.js). No hardcoded shared UUIDs.
 *   - Database URLs are asserted to point at localhost / 127.0.0.1
 *     unless the Render escape-hatch triad is set
 *     (GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true + LYLO_WEB_MODE=true +
 *     LYLO_SHELL_MODE=true). Same posture for LYLO_APP_DATABASE_URL
 *     (memory pool) and LYLO_SETUP_DATABASE_URL (identity / users
 *     provisioning).
 *
 * Boundary scan: this file is scanned by check-runtime-boundary.js.
 * It must not:
 *   - import @anthropic-ai/sdk (wiring.js does that)
 *   - import @supabase/supabase-js (supabase-auth.js does that — and
 *     even there it doesn't, the REST wrapper is hand-rolled)
 *   - import pg directly (identity.js + wiring.js use src/db/client
 *     and src/memory)
 *   - reference forbidden SQL keywords or non-allowlisted tables
 */

const path = require('node:path');

const logger = require('./log');
const { createTestDoorWiring } = require('../web/wiring');
const { createTestDoorServer } = require('../web/server');
const { createSessionCodec } = require('../web/session');
const { createRecentBuffer } = require('../web/recent');
const { createSupabaseAuthClient } = require('../web/supabase-auth');
const { createJwksClient } = require('../web/jwks-client');
const { createIdentityResolver, bootstrapAdminEmailsFromEnv } = require('../web/identity');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PORT = 3000;

function coarseError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'unknown';
}

function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

function isLocalDatabaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function isRenderEscapeEngaged(env) {
  return (
    String(env.GNG_TEST_INSTANCE_ALLOW_RENDER_DB || '').toLowerCase() === 'true'
    && String(env.LYLO_WEB_MODE || '').toLowerCase() === 'true'
    && String(env.LYLO_SHELL_MODE || '').toLowerCase() === 'true'
  );
}

function isAcceptableDatabaseUrl(url, env) {
  if (isLocalDatabaseUrl(url)) return true;
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    new URL(url);
  } catch {
    return false;
  }
  return isRenderEscapeEngaged(env);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function bootWeb(rawEnv) {
  const env = rawEnv || {};

  if (String(env.LYLO_WEB_MODE || '').toLowerCase() !== 'true') {
    logger.warn('boot.web.disabled', { hint: 'set LYLO_WEB_MODE=true to enable' });
    return null;
  }

  const errors = [];

  // ----- Core required env -----
  if (typeof env.ANTHROPIC_API_KEY !== 'string' || env.ANTHROPIC_API_KEY.trim() === '') {
    errors.push('ANTHROPIC_API_KEY is required');
  }
  if (typeof env.WEB_SESSION_SECRET !== 'string' || env.WEB_SESSION_SECRET.length < 16) {
    errors.push('WEB_SESSION_SECRET must be a string of length >= 16');
  }

  // ----- Database URLs -----
  if (!isAcceptableDatabaseUrl(env.LYLO_APP_DATABASE_URL, env)) {
    errors.push('LYLO_APP_DATABASE_URL must point at localhost / 127.0.0.1 (or set GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true with LYLO_WEB_MODE=true and LYLO_SHELL_MODE=true to allow a remote test-door Postgres)');
  }
  if (!isAcceptableDatabaseUrl(env.LYLO_SETUP_DATABASE_URL, env)) {
    errors.push('LYLO_SETUP_DATABASE_URL must point at localhost / 127.0.0.1 (or set the Render escape-hatch triad). Required for auth signup / login to provision public.users rows via lylo_setup_login.');
  }

  // ----- Pilot identity -----
  if (typeof env.LYLO_PILOT_INSTANCE_ID !== 'string' || !UUID_RE.test(env.LYLO_PILOT_INSTANCE_ID)) {
    errors.push('LYLO_PILOT_INSTANCE_ID must be a UUID');
  }

  // ----- Supabase Auth -----
  if (typeof env.SUPABASE_URL !== 'string' || !/^https:\/\//.test(env.SUPABASE_URL)) {
    errors.push('SUPABASE_URL must be an https:// URL');
  }
  if (typeof env.SUPABASE_ANON_KEY !== 'string' || env.SUPABASE_ANON_KEY.length < 20) {
    errors.push('SUPABASE_ANON_KEY is required');
  }
  if (typeof env.SUPABASE_JWT_SECRET !== 'string' || env.SUPABASE_JWT_SECRET.length < 16) {
    errors.push('SUPABASE_JWT_SECRET is required (length >= 16)');
  }

  if (errors.length > 0) {
    for (const message of errors) logger.error('boot.web.env_error', { message });
    throw new Error('boot.web: environment is incomplete');
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const sessionCodec = createSessionCodec({ secret: env.WEB_SESSION_SECRET });
  const recent = createRecentBuffer();
  const wiring = createTestDoorWiring({ env, log: logger.emit });

  const supabaseAuth = createSupabaseAuthClient({
    supabaseUrl: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  });
  // JWKS client for Supabase's asymmetric JWT signing keys (RS256 /
  // ES256). The HS256 path uses SUPABASE_JWT_SECRET directly; the
  // verifier picks based on the token's alg header. Projects that
  // have enabled JWT Signing Keys in the Supabase dashboard issue
  // ES256 tokens that the legacy secret CANNOT verify.
  const jwksClient = createJwksClient({
    jwksUrl: `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
    log: logger.emit,
  });
  const identity = createIdentityResolver({
    setupDatabaseUrl: env.LYLO_SETUP_DATABASE_URL,
    pilotInstanceId: env.LYLO_PILOT_INSTANCE_ID,
    bootstrapAdminEmails: bootstrapAdminEmailsFromEnv(env.LYLO_BOOTSTRAP_ADMIN_EMAILS || ''),
    log: logger.emit,
  });

  const server = createTestDoorServer({
    repoRoot,
    pilotInstanceId: env.LYLO_PILOT_INSTANCE_ID,
    sessionCodec,
    wiring,
    recent,
    supabaseAuth,
    identity,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET,
    jwtKeyLookup: jwksClient.getKey,
    expectedJwtIssuer: `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`,
    log: logger.emit,
    secureCookie: String(env.NODE_ENV || '').toLowerCase() === 'production',
  });

  const port = parsePort(env.PORT);
  await listen(server, port);
  logger.info('boot.web.listening', { port });

  let shuttingDown = null;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    logger.info('boot.web.shutdown.started');
    shuttingDown = (async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await closed;
      await wiring.close();
      await identity.close();
      logger.info('boot.web.shutdown.complete');
    })();
    return shuttingDown;
  }

  return { server, port, shutdown };
}

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { error_class: coarseError(err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('process.unhandled_rejection', { error_class: coarseError(err) });
    process.exit(1);
  });

  bootWeb(process.env)
    .then((handle) => {
      if (!handle) {
        process.exit(0);
        return;
      }
      const stop = () => {
        handle
          .shutdown()
          .catch((err) => logger.error('boot.web.shutdown.error', { error_class: coarseError(err) }))
          .finally(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      logger.error('boot.web.fatal', { error_class: coarseError(err) });
      process.exit(1);
    });
}

module.exports = { bootWeb };
