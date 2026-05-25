'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLocalDatabaseUrl,
  isRemoteDatabaseAllowed,
  isAcceptableDatabaseUrl,
} = require('../../src/runtime/boot-web');

const ALL_FLAGS = Object.freeze({
  GNG_TEST_INSTANCE_ALLOW_RENDER_DB: 'true',
  LYLO_WEB_MODE: 'true',
  LYLO_SHELL_MODE: 'true',
});

test('isLocalDatabaseUrl: accepts localhost / 127.0.0.1 / ::1', () => {
  assert.equal(isLocalDatabaseUrl('postgres://u:p@localhost:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgres://u:p@127.0.0.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgres://u:p@[::1]:5432/db'), true);
});

test('isLocalDatabaseUrl: rejects non-local hosts and malformed input', () => {
  assert.equal(isLocalDatabaseUrl('postgres://u:p@db.render.com:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgres://u:p@10.0.0.5:5432/db'), false);
  assert.equal(isLocalDatabaseUrl(''), false);
  assert.equal(isLocalDatabaseUrl(null), false);
  assert.equal(isLocalDatabaseUrl(undefined), false);
  assert.equal(isLocalDatabaseUrl('not a url'), false);
});

test('isRemoteDatabaseAllowed: requires all three flags true', () => {
  assert.equal(isRemoteDatabaseAllowed({}), false);
  assert.equal(isRemoteDatabaseAllowed(ALL_FLAGS), true);
  assert.equal(
    isRemoteDatabaseAllowed({ ...ALL_FLAGS, GNG_TEST_INSTANCE_ALLOW_RENDER_DB: 'false' }),
    false
  );
  assert.equal(isRemoteDatabaseAllowed({ ...ALL_FLAGS, LYLO_WEB_MODE: 'false' }), false);
  assert.equal(isRemoteDatabaseAllowed({ ...ALL_FLAGS, LYLO_SHELL_MODE: 'false' }), false);
});

test('isRemoteDatabaseAllowed: case-insensitive on "true"', () => {
  assert.equal(
    isRemoteDatabaseAllowed({
      GNG_TEST_INSTANCE_ALLOW_RENDER_DB: 'TRUE',
      LYLO_WEB_MODE: 'True',
      LYLO_SHELL_MODE: 'TRUE',
    }),
    true
  );
});

test('isAcceptableDatabaseUrl: local URLs always acceptable, ignoring flags', () => {
  assert.equal(isAcceptableDatabaseUrl('postgres://u:p@127.0.0.1:5432/db', {}), true);
  assert.equal(isAcceptableDatabaseUrl('postgres://u:p@localhost:5432/db', {}), true);
});

test('isAcceptableDatabaseUrl: remote URLs rejected without all three flags', () => {
  const remote = 'postgres://u:p@db.render.com:5432/db?sslmode=require';
  assert.equal(isAcceptableDatabaseUrl(remote, {}), false);
  assert.equal(
    isAcceptableDatabaseUrl(remote, { GNG_TEST_INSTANCE_ALLOW_RENDER_DB: 'true' }),
    false
  );
  assert.equal(
    isAcceptableDatabaseUrl(remote, {
      GNG_TEST_INSTANCE_ALLOW_RENDER_DB: 'true',
      LYLO_WEB_MODE: 'true',
    }),
    false
  );
});

test('isAcceptableDatabaseUrl: remote URL accepted with full triad', () => {
  const remote = 'postgres://u:p@db.render.com:5432/db?sslmode=require';
  assert.equal(isAcceptableDatabaseUrl(remote, ALL_FLAGS), true);
});

test('isAcceptableDatabaseUrl: malformed URLs always rejected, regardless of flags', () => {
  assert.equal(isAcceptableDatabaseUrl('not a url', ALL_FLAGS), false);
  assert.equal(isAcceptableDatabaseUrl('', ALL_FLAGS), false);
  assert.equal(isAcceptableDatabaseUrl(null, ALL_FLAGS), false);
});
