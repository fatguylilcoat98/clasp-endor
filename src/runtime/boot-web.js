'use strict';
/*
 * Test-door web boot entry.
 *
 * Composes the test-door HTTP server: parse env, build the
 * Anthropic-wired chat chain via src/web/wiring, build the recent
 * ring buffer, build the session codec, mount the server.
 *
 * Hard rules:
 *   - This entry is for the disposable clasp-endor test instance only.
 *     It is gated by LYLO_WEB_MODE=true.
 *   - It reads NO secrets into its own scope beyond what the test door
 *     needs: ANTHROPIC_API_KEY, LYLO_APP_DATABASE_URL, the four UUID
 *     identifiers, WEB_SESSION_SECRET, PORT.
 *   - It does NOT mount /healthz, /readyz, /status from the
 *     non-web runtime — those still live in src/runtime/boot.js for
 *     the original boot path. The web server exposes its own /healthz
 *     for liveness during local development.
 *   - Database URLs are asserted to point at localhost / 127.0.0.1.
 *     A non-local host is a hard-stop — the test door must never
 *     connect to a remote DB (including the mold's).
 *
 * This file is scanned by check-runtime-boundary.js. It must not:
 *   - import @anthropic-ai/sdk (wiring.js does that)
 *   - import pg directly (wiring uses src/memory's pool)
 *   - reference forbidden SQL keywords or non-allowlisted tables
 */

const path = require('node:path');

const logger = require('./log');
const { createTestDoorWiring } = require('../web/wiring');
const { createTestDoorServer } = require('../web/server');
const { createSessionCodec } = require('../web/session');
const { createRecentBuffer } = require('../web/recent');

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
    // Node's URL parser keeps brackets on IPv6 hostnames; strip them
    // so '[::1]' and '::1' both compare equal.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/*
 * Disposable-test-door escape hatch for remote Postgres on Render.
 *
 * Requires THREE explicit flags aligned, all on the same request:
 *   - GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true
 *   - LYLO_WEB_MODE=true
 *   - LYLO_SHELL_MODE=true
 *
 * Any one missing falls back to the localhost-only rule. This is
 * intentional: a single misconfigured flag must not unlock a remote
 * connection. The mold's boot path does NOT consult this flag (its
 * own validation is unchanged), so the escape hatch is scoped to
 * clasp-endor's test-door boot only.
 */
function isRemoteDatabaseAllowed(env) {
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
  return isRemoteDatabaseAllowed(env);
}

function readIdentities(env) {
  const errors = [];
  const ids = {
    pilotInstanceId: env.LYLO_PILOT_INSTANCE_ID,
    seniorUserId: env.LYLO_TEST_SENIOR_USER_ID,
    adminUserId: env.LYLO_TEST_ADMIN_USER_ID,
  };
  for (const [key, value] of Object.entries(ids)) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      errors.push(`${key} must be a UUID`);
    }
  }
  return { ids, errors };
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

  if (typeof env.ANTHROPIC_API_KEY !== 'string' || env.ANTHROPIC_API_KEY.trim() === '') {
    errors.push('ANTHROPIC_API_KEY is required');
  }
  if (typeof env.WEB_SESSION_SECRET !== 'string' || env.WEB_SESSION_SECRET.length < 16) {
    errors.push('WEB_SESSION_SECRET must be a string of length >= 16');
  }
  if (!isAcceptableDatabaseUrl(env.LYLO_APP_DATABASE_URL, env)) {
    errors.push(
      'LYLO_APP_DATABASE_URL must point at localhost / 127.0.0.1 '
        + '(or set GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true with '
        + 'LYLO_WEB_MODE=true and LYLO_SHELL_MODE=true to allow a '
        + 'remote test-door Postgres)'
    );
  }

  const { ids, errors: idErrors } = readIdentities(env);
  errors.push(...idErrors);

  if (errors.length > 0) {
    for (const message of errors) logger.error('boot.web.env_error', { message });
    throw new Error('boot.web: environment is incomplete');
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const sessionCodec = createSessionCodec({ secret: env.WEB_SESSION_SECRET });
  const recent = createRecentBuffer();
  const wiring = createTestDoorWiring({ env, log: logger.emit });

  const server = createTestDoorServer({
    repoRoot,
    identities: ids,
    sessionCodec,
    wiring,
    recent,
    log: logger.emit,
    secureCookie: false,
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

module.exports = {
  bootWeb,
  isLocalDatabaseUrl,
  isRemoteDatabaseAllowed,
  isAcceptableDatabaseUrl,
};
