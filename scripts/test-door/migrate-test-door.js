#!/usr/bin/env node
'use strict';
/*
 * Test-door migration runner.
 *
 * Applies every numbered SQL file under db/migrations/ to the database
 * pointed at by LYLO_SETUP_DATABASE_URL. Intended for the disposable
 * clasp-endor test door — local Postgres or, when the
 * GNG_TEST_INSTANCE_ALLOW_RENDER_DB / LYLO_WEB_MODE / LYLO_SHELL_MODE
 * triad is set, a remote test-door Postgres on Render.
 *
 * Idempotent in practice: if the schema is already applied the first
 * CREATE TABLE will raise `42P07` (relation already exists), the
 * script reports "already applied" and exits 0. That way the operator
 * can re-run on Render after a config tweak without manual cleanup.
 *
 * This script does NOT replace the operator runbook for production
 * deployments. It exists only so the test-door operator can stand up
 * a fresh Render Postgres with a single command.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const ALREADY_APPLIED_SQLSTATES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (function / trigger / role)
  '42723', // duplicate_function
  '42P06', // duplicate_schema
  '42P16', // invalid_table_definition (re-applied unique index)
]);

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

function isRemoteDatabaseAllowed() {
  return (
    String(process.env.GNG_TEST_INSTANCE_ALLOW_RENDER_DB || '').toLowerCase() === 'true'
    && String(process.env.LYLO_WEB_MODE || '').toLowerCase() === 'true'
    && String(process.env.LYLO_SHELL_MODE || '').toLowerCase() === 'true'
  );
}

function isAcceptableDatabaseUrl(url) {
  if (isLocalDatabaseUrl(url)) return true;
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    new URL(url);
  } catch {
    return false;
  }
  return isRemoteDatabaseAllowed();
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
}

async function applyOne(client, filename) {
  const abs = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(abs, 'utf8');
  try {
    await client.query(sql);
    return { filename, status: 'applied' };
  } catch (err) {
    if (err && ALREADY_APPLIED_SQLSTATES.has(err.code)) {
      return { filename, status: 'already_applied', code: err.code };
    }
    throw err;
  }
}

async function main() {
  const setupUrl = process.env.LYLO_SETUP_DATABASE_URL;
  if (!isAcceptableDatabaseUrl(setupUrl)) {
    throw new Error(
      'LYLO_SETUP_DATABASE_URL must point at localhost / 127.0.0.1 '
        + '(or set GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true with '
        + 'LYLO_WEB_MODE=true and LYLO_SHELL_MODE=true to allow a '
        + 'remote test-door Postgres) — refusing to touch a remote database'
    );
  }

  const files = listMigrations();
  if (files.length === 0) {
    throw new Error('no numbered migrations found under db/migrations/');
  }

  const client = new Client({ connectionString: setupUrl });
  await client.connect();
  let applied = 0;
  let skipped = 0;
  try {
    for (const filename of files) {
      const result = await applyOne(client, filename);
      if (result.status === 'applied') {
        process.stdout.write(`applied: ${filename}\n`);
        applied += 1;
      } else {
        process.stdout.write(`skipped (already applied): ${filename}\n`);
        skipped += 1;
      }
    }
  } finally {
    await client.end();
  }

  process.stdout.write(`\nmigrate:test-door complete — ${applied} applied, ${skipped} skipped\n`);
}

main().catch((err) => {
  process.stderr.write(`migrate:test-door: ${err.message}\n`);
  if (err && err.code) process.stderr.write(`  pg code: ${err.code}\n`);
  process.exit(1);
});
