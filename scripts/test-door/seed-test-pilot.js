#!/usr/bin/env node
'use strict';
/*
 * Test-door pilot seeder.
 *
 * Wraps the existing offline provisioner (scripts/setup/provision-instance.js)
 * with a fixed test answers JSON, then adds ONE additional admin user row
 * to the seeded pilot so the test door has both a regular (senior) user
 * and an admin user.
 *
 * Strictly local. Strictly offline. The mold's database is never
 * touched — the LYLO_SETUP_DATABASE_URL this script connects to MUST
 * point at localhost / 127.0.0.1. A non-local host is a hard-stop.
 *
 * This script does NOT touch src/runtime/ or src/web/. It is a setup
 * tool — it imports pg directly and writes only to the `users` table
 * (which already exists in the baseline migration).
 *
 * Usage:
 *   node scripts/test-door/seed-test-pilot.js --answers <path>
 *   ANSWERS_FILE=<path> node scripts/test-door/seed-test-pilot.js
 *
 * On success, prints three identifiers in shell-export form so the
 * operator can paste them into the test-door .env file:
 *
 *   export LYLO_PILOT_INSTANCE_ID=<uuid>
 *   export LYLO_TEST_SENIOR_USER_ID=<uuid>
 *   export LYLO_TEST_ADMIN_USER_ID=<uuid>
 *
 * The script never writes a .env file itself — the operator does that
 * by hand, so a misconfigured CI run cannot accidentally commit secrets.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Client } = require('pg');

const ADMIN_USERNAME = 'test_door_admin';

function isLocalDatabaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function parseInputs() {
  const args = parseArgs({
    options: {
      answers: { type: 'string' },
    },
    allowPositionals: false,
    strict: false,
  });
  const answers = args.values.answers || process.env.ANSWERS_FILE;
  if (!answers) {
    throw new Error('--answers <path> (or ANSWERS_FILE env) is required');
  }
  return { answersPath: path.resolve(answers) };
}

function runProvisioner(answersPath) {
  const provisioner = path.resolve(__dirname, '..', 'setup', 'provision-instance.js');
  const result = spawnSync(process.execPath, [provisioner, '--answers', answersPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`provision-instance.js exited with status ${result.status}`);
  }
}

async function fetchPilotAndSenior(client) {
  const pilotRes = await client.query(
    'SELECT id FROM pilot_instances ORDER BY created_at ASC LIMIT 1'
  );
  if (pilotRes.rowCount === 0) {
    throw new Error('no pilot_instances row found — provisioning did not complete');
  }
  const pilotInstanceId = pilotRes.rows[0].id;

  const seniorRes = await client.query(
    "SELECT id FROM users WHERE pilot_instance_id = $1 AND role = 'senior' LIMIT 1",
    [pilotInstanceId]
  );
  if (seniorRes.rowCount === 0) {
    throw new Error('no senior user found — provisioning did not complete');
  }
  const seniorUserId = seniorRes.rows[0].id;
  return { pilotInstanceId, seniorUserId };
}

async function ensureAdminUser(client, pilotInstanceId) {
  const existing = await client.query(
    "SELECT id FROM users WHERE pilot_instance_id = $1 AND username = $2 AND role = 'admin' LIMIT 1",
    [pilotInstanceId, ADMIN_USERNAME]
  );
  if (existing.rowCount > 0) return existing.rows[0].id;
  const inserted = await client.query(
    "INSERT INTO users (pilot_instance_id, username, role) VALUES ($1, $2, 'admin') RETURNING id",
    [pilotInstanceId, ADMIN_USERNAME]
  );
  return inserted.rows[0].id;
}

async function main() {
  const { answersPath } = parseInputs();
  const setupUrl = process.env.LYLO_SETUP_DATABASE_URL;
  if (!isLocalDatabaseUrl(setupUrl)) {
    throw new Error('LYLO_SETUP_DATABASE_URL must point at localhost / 127.0.0.1 — refusing to touch a remote database');
  }

  runProvisioner(answersPath);

  const client = new Client({ connectionString: setupUrl });
  await client.connect();
  let pilotInstanceId;
  let seniorUserId;
  let adminUserId;
  try {
    const ids = await fetchPilotAndSenior(client);
    pilotInstanceId = ids.pilotInstanceId;
    seniorUserId = ids.seniorUserId;
    adminUserId = await ensureAdminUser(client, pilotInstanceId);
  } finally {
    await client.end();
  }

  process.stdout.write('\n');
  process.stdout.write('# Test-door identifiers — paste into .env (do NOT commit):\n');
  process.stdout.write(`export LYLO_PILOT_INSTANCE_ID=${pilotInstanceId}\n`);
  process.stdout.write(`export LYLO_TEST_SENIOR_USER_ID=${seniorUserId}\n`);
  process.stdout.write(`export LYLO_TEST_ADMIN_USER_ID=${adminUserId}\n`);
}

main().catch((err) => {
  process.stderr.write(`seed-test-pilot: ${err.message}\n`);
  process.exit(1);
});
