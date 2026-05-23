'use strict';
/*
 * Boot orchestration.
 *
 * Composes the runtime: parse the environment, derive the runtime
 * state, start the health server. Fail-closed — every failure path
 * lands in a non-ready state. Configuration is restart-to-apply; the
 * only post-boot transition is ready <-> degraded.
 *
 * Logging is operational only, emitted through the structured
 * JSON-line logger. It never carries secrets, the connection string,
 * persona text, or any profile content.
 */

const { parseEnv } = require('./env');
const { STATES, deriveBootState, applyEvent } = require('./runtime-state');
const { assessConfig } = require('./validation-hook');
const { createPool, connectWithRetry, pingDatabase, closePool } = require('../db/client');
const { loadRuntimeConfig } = require('./config-loader');
const { createHealthServer } = require('./health');
const logger = require('./log');

const DEPENDENCY_CHECK_INTERVAL_MS = 15000;

// Build version: env LYLO_VERSION wins if set, otherwise the package
// manifest. Surfaces in /status only — never logged with persona,
// profile, or secret content.
const PACKAGE_VERSION = require('../../package.json').version;

// Reduce any error to a coarse, non-sensitive class for logging.
// pg errors can echo the connection string in their message; the raw
// message is never logged.
function coarseError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'unknown';
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

/*
 * Boot the runtime.
 *   rawEnv  - the environment object (process.env, or a test literal)
 *   options - optional test seams: { dbRetryDelaysMs,
 *             dependencyCheckIntervalMs }
 * Returns a handle { getState, shutdown }.
 */
async function boot(rawEnv, options) {
  const opts = options || {};
  const bootTimeMs = Date.now();

  let currentState;
  let pool = null;
  let monitor = null;

  const env = parseEnv(rawEnv);

  if (!env.ok) {
    for (const e of env.errors) logger.warn('boot.env.error', { message: e });
    currentState = STATES.CONFIGURATION_INVALID;
  } else if (!env.flags.masterSwitch) {
    logger.info('boot.inert');
    currentState = STATES.INERT;
  } else {
    pool = createPool(env.databaseUrl, { log: logger.emit });
    const conn = await connectWithRetry(pool, {
      delaysMs: opts.dbRetryDelaysMs,
      log: logger.emit,
    });
    if (!conn.connected) {
      logger.error('boot.db.unreachable', { attempts: conn.attempts });
      currentState = STATES.CONFIGURATION_INVALID;
    } else {
      try {
        const loaded = await loadRuntimeConfig(pool, { envPilotId: env.pilotInstanceId });
        if (!loaded.ok) {
          logger.error('boot.pilot.resolution_failed', { reason: loaded.reason });
          currentState = STATES.CONFIGURATION_INVALID;
        } else {
          const assessment = assessConfig(loaded.config);
          if (assessment.outcome === 'invalid') {
            logger.error('boot.config.invalid');
          }
          currentState = deriveBootState({
            masterSwitch: true,
            configOutcome: assessment.outcome,
            supportedPersonPresent: loaded.supportedPersonPresent,
          });
        }
      } catch {
        logger.error('boot.config.load_failed');
        currentState = STATES.CONFIGURATION_INVALID;
      }
    }
  }

  logger.info('boot.state', { state: currentState });

  // The health server starts in every state so the state is observable.
  const version = env.version || PACKAGE_VERSION;
  const healthServer = createHealthServer({
    getState: () => currentState,
    flags: env.flags,
    bootTimeMs,
    version,
  });
  await listen(healthServer, env.port);
  logger.info('boot.health.listening', { port: env.port });

  // Post-boot dependency monitor: ready <-> degraded only.
  if (pool && currentState === STATES.READY) {
    const intervalMs = opts.dependencyCheckIntervalMs || DEPENDENCY_CHECK_INTERVAL_MS;
    monitor = setInterval(async () => {
      const reachable = await pingDatabase(pool);
      if (!reachable && currentState === STATES.READY) {
        currentState = applyEvent(currentState, 'dependency-lost');
        logger.warn('runtime.dependency.lost', { state: currentState });
      } else if (reachable && currentState === STATES.DEGRADED) {
        currentState = applyEvent(currentState, 'dependency-restored');
        logger.info('runtime.dependency.restored', { state: currentState });
      }
    }, intervalMs);
    if (monitor.unref) monitor.unref();
  }

  // Shutdown is idempotent — repeated invocations (e.g. a double
  // SIGTERM from an orchestrator) return the in-flight promise object
  // and produce no additional side effects. This deliberately is NOT
  // an async function — an async wrapper would wrap the cached promise
  // in a fresh one on every call, breaking idempotency.
  let shuttingDown = null;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    const shutdownStartMs = Date.now();
    logger.info('boot.shutdown.started');
    shuttingDown = (async () => {
      if (monitor) clearInterval(monitor);
      const closed = new Promise((resolve) => healthServer.close(resolve));
      // Force-drain held keep-alive sockets so the health server cannot
      // hang shutdown waiting for a slow client to release a connection.
      if (typeof healthServer.closeAllConnections === 'function') {
        healthServer.closeAllConnections();
      }
      await closed;
      if (pool) await closePool(pool);
      logger.info('boot.shutdown.complete', {
        durationMs: Date.now() - shutdownStartMs,
      });
    })();
    return shuttingDown;
  }

  return { getState: () => currentState, shutdown };
}

if (require.main === module) {
  // Fail-fast on programmer errors. A coarse class is logged — never
  // the raw message, which could echo secrets — and the process exits
  // non-zero so the orchestrator can restart it.
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { error_class: coarseError(err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('process.unhandled_rejection', { error_class: coarseError(err) });
    process.exit(1);
  });

  boot(process.env)
    .then((handle) => {
      const stop = () => {
        // A shutdown rejection must not silently hang the process; the
        // finally clause guarantees the exit.
        handle
          .shutdown()
          .catch((err) => {
            logger.error('boot.shutdown.error', { error_class: coarseError(err) });
          })
          .finally(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      logger.error('boot.fatal', { error_class: coarseError(err) });
      process.exit(1);
    });
}

module.exports = { boot };
