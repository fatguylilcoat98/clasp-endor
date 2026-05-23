'use strict';
/*
 * Health / readiness HTTP server.
 *
 * Exposes three endpoints over Node's standard-library http — no web
 * framework. The server is given only non-sensitive inputs: the current
 * runtime state, feature-flag booleans, and the boot time. It has no
 * access to the configuration, persona, or any profile, so it cannot
 * leak them.
 */

const http = require('node:http');
const { isReady } = require('./runtime-state');

/*
 * Build the response for a request path. Pure.
 *   pathname - the request path
 *   ctx      - { state, flags, bootTimeMs, nowMs }
 * Returns { statusCode, body }.
 */
function buildHealthResponse(pathname, ctx) {
  const ready = isReady(ctx.state);

  if (pathname === '/healthz') {
    return { statusCode: 200, body: { status: 'live' } };
  }
  if (pathname === '/readyz') {
    return { statusCode: ready ? 200 : 503, body: { state: ctx.state, ready } };
  }
  if (pathname === '/status') {
    return {
      statusCode: 200,
      body: {
        state: ctx.state,
        ready,
        uptimeSeconds: Math.max(0, Math.floor((ctx.nowMs - ctx.bootTimeMs) / 1000)),
        version: ctx.version,
        flags: ctx.flags,
      },
    };
  }
  return { statusCode: 404, body: { error: 'not found' } };
}

/*
 * Create the health server.
 *   options - { getState, flags, bootTimeMs, version }
 * getState is a callback so the server always reports the current
 * runtime state, which may move between ready and degraded.
 * version appears in /status only — never in /healthz or /readyz.
 */
function createHealthServer(options) {
  const getState = options.getState;
  const flags = options.flags || {};
  const bootTimeMs = options.bootTimeMs || Date.now();
  const version = options.version || 'unknown';

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    const { statusCode, body } = buildHealthResponse(pathname, {
      state: getState(),
      flags,
      bootTimeMs,
      nowMs: Date.now(),
      version,
    });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  // Lifecycle hardening: a slow client must not hold a request open
  // indefinitely. The Node defaults (5 min request, 1 min headers) are
  // too lenient for a health endpoint.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

module.exports = { createHealthServer, buildHealthResponse };
