'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv } = require('../../src/runtime/env');

test('parseEnv: an empty environment is not ok and flags default to false', () => {
  const result = parseEnv({});
  assert.equal(result.ok, false);
  assert.equal(result.flags.masterSwitch, false);
  assert.equal(result.flags.rlsEnforced, false);
  assert.equal(result.flags.setupModeEnabled, false);
  assert.equal(result.flags.voiceEnabled, false);
  assert.equal(result.flags.legacyProjectModeEnabled, false);
  assert.ok(result.errors.some((e) => e.includes('DATABASE_URL')));
});

test('parseEnv: a complete environment is ok', () => {
  const result = parseEnv({
    LYLO_SHELL_MODE: 'true',
    DATABASE_URL: 'postgres://example/db',
  });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.flags.masterSwitch, true);
  assert.equal(result.databaseUrl, 'postgres://example/db');
});

test('parseEnv: boolean flags accept true/false/1/0', () => {
  assert.equal(parseEnv({ DATABASE_URL: 'x', RLS_ENFORCED: 'true' }).flags.rlsEnforced, true);
  assert.equal(parseEnv({ DATABASE_URL: 'x', RLS_ENFORCED: '1' }).flags.rlsEnforced, true);
  assert.equal(parseEnv({ DATABASE_URL: 'x', RLS_ENFORCED: 'false' }).flags.rlsEnforced, false);
  assert.equal(parseEnv({ DATABASE_URL: 'x', RLS_ENFORCED: '0' }).flags.rlsEnforced, false);
});

test('parseEnv: an unparseable boolean is an error', () => {
  const result = parseEnv({ DATABASE_URL: 'x', VOICE_ENABLED: 'maybe' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('VOICE_ENABLED')));
});

test('parseEnv: PILOT_INSTANCE_ID is optional and trimmed', () => {
  assert.equal(parseEnv({ DATABASE_URL: 'x' }).pilotInstanceId, null);
  assert.equal(
    parseEnv({ DATABASE_URL: 'x', PILOT_INSTANCE_ID: '  abc  ' }).pilotInstanceId,
    'abc'
  );
});

test('parseEnv: rlsEnforced is independent of the master switch', () => {
  const result = parseEnv({ DATABASE_URL: 'x', LYLO_SHELL_MODE: 'false', RLS_ENFORCED: 'true' });
  assert.equal(result.ok, true);
  assert.equal(result.flags.masterSwitch, false);
  assert.equal(result.flags.rlsEnforced, true);
});

test('parseEnv: PORT defaults to 3000 when unset', () => {
  assert.equal(parseEnv({ DATABASE_URL: 'x' }).port, 3000);
});

test('parseEnv: a valid PORT is parsed', () => {
  const result = parseEnv({ DATABASE_URL: 'x', PORT: '8080' });
  assert.equal(result.ok, true);
  assert.equal(result.port, 8080);
});

test('parseEnv: a non-numeric PORT is an error', () => {
  const result = parseEnv({ DATABASE_URL: 'x', PORT: 'abc' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('PORT')));
});

test('parseEnv: an out-of-range PORT is an error', () => {
  assert.equal(parseEnv({ DATABASE_URL: 'x', PORT: '0' }).ok, false);
  assert.equal(parseEnv({ DATABASE_URL: 'x', PORT: '70000' }).ok, false);
});

test('parseEnv: LYLO_VERSION is read as an optional string and trimmed', () => {
  assert.equal(parseEnv({ DATABASE_URL: 'x' }).version, null);
  assert.equal(parseEnv({ DATABASE_URL: 'x', LYLO_VERSION: 'v1.2.3' }).version, 'v1.2.3');
  assert.equal(
    parseEnv({ DATABASE_URL: 'x', LYLO_VERSION: '  v1.2.3  ' }).version,
    'v1.2.3'
  );
});
