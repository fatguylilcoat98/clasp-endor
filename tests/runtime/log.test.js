'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../src/runtime/log');

// Capture process.stdout.write synchronously during fn(). The logger
// uses process.stdout.write directly, so this swap is sufficient.
function captureStdout(fn) {
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured.join('');
}

function parseLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('logger: each entry is a single line of valid JSON', () => {
  const out = captureStdout(() => {
    logger.info('test.event');
    logger.warn('another.event');
    logger.error('an.error');
  });
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('logger: every entry includes ts, level, event, pid', () => {
  const out = captureStdout(() => logger.info('x'));
  const entry = parseLines(out)[0];
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(entry.level, 'info');
  assert.equal(entry.event, 'x');
  assert.equal(typeof entry.pid, 'number');
  assert.ok(entry.pid > 0);
});

test('logger: levels route to the correct level field', () => {
  const out = captureStdout(() => {
    logger.info('e');
    logger.warn('e');
    logger.error('e');
  });
  const entries = parseLines(out);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[1].level, 'warn');
  assert.equal(entries[2].level, 'error');
});

test('logger: caller-supplied fields are merged into the entry', () => {
  const out = captureStdout(() => {
    logger.info('boot.state', { state: 'ready' });
    logger.warn('db.connect.attempt_failed', {
      attempt: 2,
      max: 4,
      error_class: 'ECONNREFUSED',
    });
  });
  const [a, b] = parseLines(out);
  assert.equal(a.state, 'ready');
  assert.equal(b.attempt, 2);
  assert.equal(b.max, 4);
  assert.equal(b.error_class, 'ECONNREFUSED');
});

test('logger: core fields cannot be overridden by caller-supplied fields', () => {
  const out = captureStdout(() => {
    logger.info('real.event', {
      ts: 'fake-ts',
      level: 'fake',
      event: 'fake.event',
      pid: -1,
      extra: 'kept',
    });
  });
  const entry = parseLines(out)[0];
  assert.notEqual(entry.ts, 'fake-ts');
  assert.equal(entry.level, 'info');
  assert.equal(entry.event, 'real.event');
  assert.notEqual(entry.pid, -1);
  assert.equal(entry.extra, 'kept');
});

test('logger: emit(level, event, fields) is the structured callback shape', () => {
  // The exported emit() function has the (level, event, fields)
  // signature used by db/client.js. It must produce valid JSON-line
  // output with the level the caller passes.
  const out = captureStdout(() => {
    logger.emit('warn', 'db.connect.attempt_failed', {
      attempt: 1,
      max: 4,
      error_class: 'ENOTFOUND',
    });
  });
  const entry = parseLines(out)[0];
  assert.equal(entry.level, 'warn');
  assert.equal(entry.event, 'db.connect.attempt_failed');
  assert.equal(entry.error_class, 'ENOTFOUND');
});

test('logger: R4 — output of the catalogued boot events never leaks sensitive substrings', () => {
  // Replay every event boot.js or db/client.js can emit with
  // representative safe fields. Assert the resulting JSON-line output
  // contains none of the forbidden substrings. This catches an
  // accidental regression where a future change injects sensitive data
  // through the existing call sites.
  const out = captureStdout(() => {
    logger.warn('boot.env.error', { message: 'PORT: expected an integer, got "abc"' });
    logger.info('boot.inert');
    logger.error('boot.db.unreachable', { attempts: 4 });
    logger.error('boot.pilot.resolution_failed', {
      reason: 'no pilot_instances row exists',
    });
    logger.error('boot.config.invalid');
    logger.error('boot.config.load_failed');
    logger.info('boot.state', { state: 'ready' });
    logger.info('boot.health.listening', { port: 3000 });
    logger.warn('runtime.dependency.lost', { state: 'degraded' });
    logger.info('runtime.dependency.restored', { state: 'ready' });
    logger.error('process.uncaught_exception', { error_class: 'TypeError' });
    logger.error('process.unhandled_rejection', { error_class: 'TypeError' });
    logger.error('boot.shutdown.error', { error_class: 'ERR_SERVER_NOT_RUNNING' });
    logger.error('boot.fatal', { error_class: 'EADDRINUSE' });
    logger.error('db.pool.error', { error_class: 'ECONNRESET' });
    logger.warn('db.connect.attempt_failed', {
      attempt: 1,
      max: 4,
      error_class: 'ECONNREFUSED',
    });
  });
  for (const forbidden of [
    'postgres://',
    'password',
    'connectionString',
    'connection_string',
    'DATABASE_URL',
    'persona',
    'companion_name',
    'display_name',
    'preferences',
    'Mattie',
    'Sandy',
  ]) {
    assert.equal(
      out.includes(forbidden),
      false,
      `log output must not contain "${forbidden}"`
    );
  }
});
