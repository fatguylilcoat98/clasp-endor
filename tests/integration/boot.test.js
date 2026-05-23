'use strict';

/*
 * Runtime integration tests.
 *
 * Boots the runtime against a real throwaway Postgres database and
 * asserts the resulting runtime state and health output for each seed
 * scenario. Requires DATABASE_URL (set by the integration-tests CI job
 * to a Postgres 16 service container).
 */

const test = require('node:test');
const before = test.before;
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { boot } = require('../../src/runtime/boot');

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_PORT = 13577;
const FAST_DELAYS = [5, 5, 5, 5];
const REPO = path.join(__dirname, '..', '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
}

const blankCompanion = readJson('config/companion.example.json').companion;
const filledCompanion = readJson('tests/config/valid/filled-text-only.json').companion;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set for the integration tests');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  await client.end();
});

async function withDb(fn) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function reset(client) {
  await client.query('TRUNCATE pilot_instances CASCADE');
}

async function seedPilot(client) {
  const r = await client.query(
    "INSERT INTO pilot_instances (org_name) VALUES ('Test Org') RETURNING id"
  );
  return r.rows[0].id;
}

async function seedSenior(client, pilotId) {
  const r = await client.query(
    "INSERT INTO users (pilot_instance_id, username, role) VALUES ($1, 'senior1', 'senior') RETURNING id",
    [pilotId]
  );
  return r.rows[0].id;
}

async function seedCompanionProfile(client, pilotId, companion) {
  await client.query(
    'INSERT INTO companion_profile (pilot_instance_id, companion_name, persona, voice, safety) '
      + 'VALUES ($1, $2, $3, $4, $5)',
    [
      pilotId,
      companion.name,
      JSON.stringify(companion.persona),
      JSON.stringify(companion.voice),
      JSON.stringify(companion.safety),
    ]
  );
}

async function seedSupportedPerson(client, pilotId, userId) {
  await client.query(
    'INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) '
      + "VALUES ($1, $2, 'Supported Person')",
    [pilotId, userId]
  );
}

function httpGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

async function bootAndProbe(extraEnv) {
  const rawEnv = { DATABASE_URL, PORT: String(TEST_PORT), ...extraEnv };
  const handle = await boot(rawEnv, { dbRetryDelaysMs: FAST_DELAYS });
  try {
    return {
      state: handle.getState(),
      healthz: await httpGet(TEST_PORT, '/healthz'),
      readyz: await httpGet(TEST_PORT, '/readyz'),
      status: await httpGet(TEST_PORT, '/status'),
    };
  } finally {
    await handle.shutdown();
  }
}

test('inert: Layer-1 master switch off', async () => {
  await withDb(async (c) => {
    await reset(c);
    await seedPilot(c);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'false' });
  assert.equal(r.state, 'inert');
  assert.equal(r.healthz.statusCode, 200);
  assert.equal(r.readyz.statusCode, 503);
});

test('configuration-invalid: no pilot row', async () => {
  await withDb(async (c) => {
    await reset(c);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'configuration-invalid');
  assert.equal(r.readyz.statusCode, 503);
});

test('configuration-invalid: more than one pilot row', async () => {
  await withDb(async (c) => {
    await reset(c);
    await seedPilot(c);
    await seedPilot(c);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'configuration-invalid');
});

test('setup-incomplete: pilot but no companion_profile', async () => {
  await withDb(async (c) => {
    await reset(c);
    await seedPilot(c);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'setup-incomplete');
  assert.equal(r.readyz.statusCode, 503);
});

test('setup-incomplete: blank companion_profile', async () => {
  await withDb(async (c) => {
    await reset(c);
    const pid = await seedPilot(c);
    await seedCompanionProfile(c, pid, blankCompanion);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'setup-incomplete');
});

test('setup-incomplete: valid companion_profile but no supported person', async () => {
  await withDb(async (c) => {
    await reset(c);
    const pid = await seedPilot(c);
    await seedCompanionProfile(c, pid, filledCompanion);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'setup-incomplete');
});

test('ready: valid companion_profile and supported person', async () => {
  await withDb(async (c) => {
    await reset(c);
    const pid = await seedPilot(c);
    const uid = await seedSenior(c, pid);
    await seedCompanionProfile(c, pid, filledCompanion);
    await seedSupportedPerson(c, pid, uid);
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'ready');
  assert.equal(r.healthz.statusCode, 200);
  assert.equal(r.readyz.statusCode, 200);
  assert.equal(r.status.statusCode, 200);
  // Health output must never expose persona or profile content.
  for (const probe of [r.healthz, r.readyz, r.status]) {
    assert.equal(probe.body.includes('Aria'), false, 'must not expose the companion name');
    assert.equal(probe.body.includes('warm'), false, 'must not expose persona text');
    assert.equal(probe.body.includes('Supported Person'), false, 'must not expose profile data');
  }

  // /status carries a non-empty version string (operational visibility).
  const statusBody = JSON.parse(r.status.body);
  assert.equal(typeof statusBody.version, 'string', 'version must be a string');
  assert.ok(statusBody.version.length > 0, 'version must be non-empty');
  // version appears in /status only — never in /healthz or /readyz.
  assert.equal(r.healthz.body.includes('version'), false);
  assert.equal(r.readyz.body.includes('version'), false);
});

test('configuration-invalid: malformed companion_profile', async () => {
  await withDb(async (c) => {
    await reset(c);
    const pid = await seedPilot(c);
    await c.query(
      'INSERT INTO companion_profile (pilot_instance_id, companion_name, persona, voice, safety) '
        + 'VALUES ($1, $2, $3, $4, $5)',
      [pid, 'X', '{}', '{}', '{}']
    );
  });
  const r = await bootAndProbe({ LYLO_SHELL_MODE: 'true' });
  assert.equal(r.state, 'configuration-invalid');
});

test('configuration-invalid: PILOT_INSTANCE_ID mismatch', async () => {
  await withDb(async (c) => {
    await reset(c);
    await seedPilot(c);
  });
  const r = await bootAndProbe({
    LYLO_SHELL_MODE: 'true',
    PILOT_INSTANCE_ID: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(r.state, 'configuration-invalid');
});

test('configuration-invalid: database unreachable', async () => {
  const handle = await boot(
    {
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/unreachable',
      PORT: String(TEST_PORT),
      LYLO_SHELL_MODE: 'true',
    },
    { dbRetryDelaysMs: FAST_DELAYS }
  );
  try {
    assert.equal(handle.getState(), 'configuration-invalid');
    const readyz = await httpGet(TEST_PORT, '/readyz');
    assert.equal(readyz.statusCode, 503);
  } finally {
    await handle.shutdown();
  }
});

test('shutdown: idempotent, force-closes sockets, and emits start/complete events', async () => {
  await withDb(async (c) => {
    await reset(c);
    const pid = await seedPilot(c);
    const uid = await seedSenior(c, pid);
    await seedCompanionProfile(c, pid, filledCompanion);
    await seedSupportedPerson(c, pid, uid);
  });

  // Capture stdout so we can verify the shutdown events were emitted.
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };

  let agent;
  try {
    const handle = await boot(
      { DATABASE_URL, PORT: String(TEST_PORT), LYLO_SHELL_MODE: 'true' },
      { dbRetryDelaysMs: FAST_DELAYS }
    );
    assert.equal(handle.getState(), 'ready');

    // Open a keep-alive connection that we deliberately do not release.
    // Without closeAllConnections, the held socket would force shutdown
    // to wait up to keepAliveTimeout.
    agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: TEST_PORT, path: '/healthz', agent }, (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        })
        .on('error', reject);
    });

    const start = Date.now();
    const p1 = handle.shutdown();
    const p2 = handle.shutdown();
    assert.equal(p1, p2, 'shutdown() must return the same promise on re-entry');
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `shutdown should complete promptly, took ${elapsed}ms`);
  } finally {
    process.stdout.write = originalWrite;
    if (agent) agent.destroy();
  }

  // Parse the captured JSON-line logs and assert the new shutdown events.
  const entries = captured
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  assert.ok(
    entries.some((e) => e.event === 'boot.shutdown.started'),
    'boot.shutdown.started must be emitted'
  );
  const complete = entries.find((e) => e.event === 'boot.shutdown.complete');
  assert.ok(complete, 'boot.shutdown.complete must be emitted');
  assert.equal(typeof complete.durationMs, 'number');
  assert.ok(complete.durationMs >= 0);
});
