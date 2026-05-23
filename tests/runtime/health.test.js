'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthResponse } = require('../../src/runtime/health');
const { STATES } = require('../../src/runtime/runtime-state');

const baseCtx = {
  state: STATES.READY,
  flags: { masterSwitch: true, voiceEnabled: false },
  bootTimeMs: 1000,
  nowMs: 6000,
  version: '1.2.3',
};

test('buildHealthResponse: /healthz is 200 live in every state', () => {
  for (const state of Object.values(STATES)) {
    const r = buildHealthResponse('/healthz', { ...baseCtx, state });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { status: 'live' });
  }
});

test('buildHealthResponse: /readyz is 200 only when ready', () => {
  assert.equal(
    buildHealthResponse('/readyz', { ...baseCtx, state: STATES.READY }).statusCode,
    200
  );
  for (const state of [
    STATES.INERT,
    STATES.SETUP_INCOMPLETE,
    STATES.CONFIGURATION_INVALID,
    STATES.DEGRADED,
  ]) {
    const r = buildHealthResponse('/readyz', { ...baseCtx, state });
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.ready, false);
    assert.equal(r.body.state, state);
  }
});

test('buildHealthResponse: /status reports state, readiness, uptime, version, flags', () => {
  const r = buildHealthResponse('/status', baseCtx);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state, STATES.READY);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.uptimeSeconds, 5);
  assert.equal(r.body.version, '1.2.3');
  assert.deepEqual(r.body.flags, { masterSwitch: true, voiceEnabled: false });
});

test('buildHealthResponse: version appears only in /status, never in /healthz or /readyz', () => {
  const status = buildHealthResponse('/status', baseCtx).body;
  assert.equal(status.version, '1.2.3');
  const healthz = buildHealthResponse('/healthz', baseCtx).body;
  assert.equal(healthz.version, undefined);
  const readyz = buildHealthResponse('/readyz', baseCtx).body;
  assert.equal(readyz.version, undefined);
});

test('buildHealthResponse: an unknown path is 404', () => {
  assert.equal(buildHealthResponse('/secrets', baseCtx).statusCode, 404);
});

test('createHealthServer: sets requestTimeout and headersTimeout to 10s', () => {
  const { createHealthServer } = require('../../src/runtime/health');
  const server = createHealthServer({
    getState: () => STATES.READY,
    flags: { masterSwitch: true },
    bootTimeMs: Date.now(),
  });
  assert.equal(server.requestTimeout, 10_000);
  assert.equal(server.headersTimeout, 10_000);
  server.close();
});

test('buildHealthResponse: no response exposes config, persona, profile, or secrets', () => {
  for (const path of ['/healthz', '/readyz', '/status', '/other']) {
    const serialized = JSON.stringify(buildHealthResponse(path, baseCtx).body);
    for (const forbidden of [
      'persona',
      'companion',
      'voice_id',
      'display_name',
      'preferences',
      'databaseUrl',
      'connectionString',
      'password',
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `${path} response must not expose "${forbidden}"`
      );
    }
  }
});
