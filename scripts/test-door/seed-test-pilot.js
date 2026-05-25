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

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Client } = require('pg');

const ADMIN_USERNAME = 'test_door_admin';

// Built-in defaults for the test-door pilot. Placeholder labels only —
// no real client data. Used when --answers is not supplied so the
// operator can run `npm run seed:test-door` with zero arguments on a
// fresh Render shell.
const DEFAULT_ANSWERS = Object.freeze({
  schema_version: '1.0',
  pilot:            { org_name: 'Test Door' },
  senior:           { username: 'test_door_senior' },
  supported_person: { display_name: 'Test User', timezone: 'UTC', locale: 'en-US' },
  companion: {
    name: 'Test Companion',
    persona: {
      tone: 'warm',
      speaking_style: 'clear and simple',
      values: [],
      warmth_level: 'standard',
      cultural_tone: 'none',
      cultural_notes: '',
      faith_tone: 'none',
      faith_notes: '',
      topics: { disallowed: [], encouraged: [], notes: '' },
      terminology: {
        family_term: 'family',
        caregiver_term: 'caregiver',
        supported_person_term: 'the person you support',
      },
      reminders: { style: 'gentle', frequency: 'as_scheduled' },
    },
    voice:  { enabled: false, voice_id: '', speaking_rate: 'normal' },
    safety: {
      posture: 'standard',
      emotional_boundaries: { comfort_role: 'supportive_companion' },
      escalation: { preferred_channel: 'circle', contact_order: [] },
    },
  },
});

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

// Disposable-test-door escape hatch for Render-hosted Postgres.
// Mirror the boot-web rule: three aligned flags or it stays local-only.
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

function parseInputs() {
  const args = parseArgs({
    options: {
      answers: { type: 'string' },
    },
    allowPositionals: false,
    strict: false,
  });
  const answers = args.values.answers || process.env.ANSWERS_FILE;
  if (answers) {
    return { answersPath: path.resolve(answers), tempAnswers: false };
  }
  // Zero-argument path: write the built-in defaults to a temp file
  // and use that. The temp file lives in os.tmpdir() and is removed
  // after provisioning runs (success or failure).
  const tempPath = path.join(os.tmpdir(), `test-door-answers-${process.pid}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(DEFAULT_ANSWERS, null, 2));
  return { answersPath: tempPath, tempAnswers: true };
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
  const { answersPath, tempAnswers } = parseInputs();
  const setupUrl = process.env.LYLO_SETUP_DATABASE_URL;
  if (!isAcceptableDatabaseUrl(setupUrl)) {
    if (tempAnswers) { try { fs.unlinkSync(answersPath); } catch { /* ignore */ } }
    throw new Error(
      'LYLO_SETUP_DATABASE_URL must point at localhost / 127.0.0.1 '
        + '(or set GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true with '
        + 'LYLO_WEB_MODE=true and LYLO_SHELL_MODE=true to allow a '
        + 'remote test-door Postgres) — refusing to touch a remote database'
    );
  }

  // Idempotency: if a pilot already exists, skip provisioning and
  // just look up the existing IDs. This lets the operator re-run the
  // command after fixing config without hitting the provisioner's
  // "pilot already exists" guard.
  const preflightClient = new Client({ connectionString: setupUrl });
  await preflightClient.connect();
  let alreadyProvisioned = false;
  try {
    const existing = await preflightClient.query(
      'SELECT id FROM pilot_instances LIMIT 1'
    );
    alreadyProvisioned = existing.rowCount > 0;
  } finally {
    await preflightClient.end();
  }

  if (!alreadyProvisioned) {
    try {
      runProvisioner(answersPath);
    } finally {
      if (tempAnswers) { try { fs.unlinkSync(answersPath); } catch { /* ignore */ } }
    }
  } else if (tempAnswers) {
    try { fs.unlinkSync(answersPath); } catch { /* ignore */ }
  }

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
  if (alreadyProvisioned) {
    process.stdout.write('# Existing test-door pilot found — reusing.\n');
  }
  process.stdout.write('# Test-door identifiers — paste into Render env (do NOT commit):\n');
  process.stdout.write(`LYLO_PILOT_INSTANCE_ID=${pilotInstanceId}\n`);
  process.stdout.write(`LYLO_TEST_SENIOR_USER_ID=${seniorUserId}\n`);
  process.stdout.write(`LYLO_TEST_ADMIN_USER_ID=${adminUserId}\n`);
}

main().catch((err) => {
  process.stderr.write(`seed-test-pilot: ${err.message}\n`);
  process.exit(1);
});
