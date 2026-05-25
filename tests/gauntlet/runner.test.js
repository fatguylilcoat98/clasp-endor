'use strict';
/*
 * Gauntlet runner — GM-30.
 *
 * Loads every JSON scenario under tests/gauntlet/scenarios/ and
 * runs it end-to-end through src/gauntlet/harness.js. Each
 * scenario's `expect` block is the contract: the runner asserts
 * the actual result matches.
 *
 * Manual scenarios under tests/gauntlet/manual/ are NOT loaded
 * unless the runner is invoked with the explicit environment
 * variable GAUNTLET_MANUAL=1 (per OQ-30.15 + constitutional
 * addendum 4; GM-30 harness-corrective patch replaced the
 * original `--manual` argv flag because node --test does not
 * propagate child-process arguments reliably). L38 in the
 * adversarial suite asserts both the directory contract AND
 * the env-var contract.
 *
 * Per OQ-30.5: drops + re-applies the schema and fixtures
 * BEFORE EACH scenario via the bootstrap superuser. The pool
 * the harness uses is the lylo_app_login pool — the only
 * connection role the production review module would use.
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const {
  createReviewQueuePool,
  closeReviewQueuePool,
} = require('../../src/review');
const {
  loadScenarioFromFile,
  runScenario,
} = require('../../src/gauntlet');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const MANUAL_DIR = path.join(__dirname, 'manual');

let reviewPool;

function discoverScenarios(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function resetSchemaAndFixtures() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const migrationsDir = path.join(REPO, 'db', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort();
    for (const f of files) {
      await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    }
    await client.query(
      fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
    );
  } finally {
    await client.end();
  }
}

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set for the gauntlet');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL must be set for the gauntlet');
  // The pool is shared across scenarios; each scenario re-runs
  // fixtures.reset internally so connections see a clean schema.
  reviewPool = createReviewQueuePool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (reviewPool) await closeReviewQueuePool(reviewPool);
});

// Build the per-test discovery list. Versioned scenarios always
// run. Manual scenarios run only if GAUNTLET_MANUAL=1 is set in
// the environment. Per L38, the directory boundary is
// structural; the env-var contract is mechanical.
const versioned = discoverScenarios(SCENARIOS_DIR);
const wantManual = process.env.GAUNTLET_MANUAL === '1';
const manual = wantManual ? discoverScenarios(MANUAL_DIR) : [];

for (const file of versioned) {
  const rel = path.relative(REPO, file);
  test(`gauntlet versioned: ${path.basename(file)}`, async () => {
    const scenario = loadScenarioFromFile(file);
    const result = await runScenario(scenario, { reviewPool, resetSchemaAndFixtures });
    assert.equal(
      result.result, scenario.expect.result,
      `scenario ${rel}: expected ${scenario.expect.result}, got ${result.result} (errorClass=${result.errorClass}, layerHit=${result.layerHit})`
    );
    if (scenario.expect.errorClassMatches !== null) {
      assert.equal(
        result.errorClassMatched, true,
        `scenario ${rel}: errorClass "${result.errorClass}" did not match /${scenario.expect.errorClassMatches}/`
      );
    }
    // The result must be a fully-rendered immutable object with
    // the locked top-level shape.
    assert.ok(typeof result.scenarioId === 'string');
    assert.equal(result.scenarioVersion, '1.0.0');
    assert.ok(Array.isArray(result.trace));
    assert.ok(typeof result.council === 'object');
    assert.equal(result.council.classification, null,
      'fresh result must have null council.classification');
  });
}

for (const file of manual) {
  test(`gauntlet manual (NOT in CI): ${path.basename(file)}`, async () => {
    const scenario = loadScenarioFromFile(file);
    const result = await runScenario(scenario, { reviewPool, resetSchemaAndFixtures });
    // Manual scenarios are diagnostic: emit the result JSON to
    // stdout for council paste-back; do NOT assert.
    console.log(JSON.stringify(result));
  });
}
