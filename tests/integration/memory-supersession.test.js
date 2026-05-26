'use strict';

/*
 * Memory supersession + Daniel poisoned-memory integration test.
 *
 * Proves the end-to-end correction path against the real schema +
 * real lylo_app LOGIN role + real audit-bundling.
 *
 * Scenario (per the hardening plan, Task 2):
 *
 *   A. A pre-existing memory states "User's brother is named Daniel"
 *      (active, WORKING_ACTIVE).
 *   B. The user says "I don't have a brother named Daniel". The
 *      extractor emits a CORRECTION fact (we simulate this by
 *      calling the writer directly with the CORRECTION content,
 *      bypassing extractor heuristics so the test is deterministic).
 *   C. After supersession, the original Daniel row is active=false /
 *      SUPERSEDED. The CORRECTION row is active=true / WORKING_ACTIVE.
 *   D. A fresh retrieval (modelling a new chat turn) returns the
 *      CORRECTION row and NOT the Daniel row.
 *   E. A brand-new pool (modelling a new session / restarted process)
 *      sees the same — the original Daniel never resurrects.
 *
 * The authority-hierarchy ranking from
 * src/memory/repository.js#computeAuthority is also verified: the
 * CORRECTION row carries authority_level='USER_CORRECTED'.
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const {
  createMemoryPool,
  closeMemoryPool,
  withMemoryContext,
} = require('../../src/memory');
const { createMemoryWriter } = require('../../src/memory');
const { createCompanionReader } = require('../../src/companion');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

// Reuse the two-pilot IDs from the existing rls-contract fixtures.
const PILOT_A  = '11111111-1111-1111-1111-111111111111';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

let appPool;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(
    LYLO_APP_DATABASE_URL,
    'LYLO_APP_DATABASE_URL (lylo_app LOGIN role) must be set'
  );

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
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  appPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (appPool) await closeMemoryPool(appPool);
});

// Mocked extractor — returns exactly the CORRECTION fact we want the
// writer to process. Replaces the real extractor (regex + Layer 2 Groq)
// so the test is deterministic regardless of the operator's GROQ_API_KEY
// or any future extractor tuning.
function loadWriterWithMockedExtractor(facts) {
  const extractorPath = require.resolve('../../src/memory/extractor');
  const writerPath = require.resolve('../../src/memory/writer');
  require.cache[extractorPath] = {
    id: extractorPath,
    filename: extractorPath,
    loaded: true,
    exports: { extractMemoriableFacts: async () => facts },
  };
  delete require.cache[writerPath];
  return require(writerPath);
}

function clearMocks() {
  delete require.cache[require.resolve('../../src/memory/extractor')];
  delete require.cache[require.resolve('../../src/memory/writer')];
}

test('Daniel scenario: seed → correct → retrieve → re-pool → still corrected', async () => {
  // A. Seed the poisoned fact directly via the governed write path.
  //    Using the production insertPrivateMemory keeps the audit row
  //    too — the seed itself is a real `memory.created` event.
  const seedResult = await withMemoryContext(
    appPool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    (ctx) => ctx.insertPrivateMemory({
      content: "User's brother is named Daniel",
      provenance: 'USER_STATED',
      memoryStatus: 'WORKING_ACTIVE',
    })
  );
  assert.ok(seedResult.id, 'seed insert returned an id');

  // Pre-correction sanity: reader sees Daniel.
  const reader = createCompanionReader({ memoryPool: appPool });
  const pre = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.ok(
    pre.some((r) => r.content === "User's brother is named Daniel"),
    'pre-correction: Daniel must be visible'
  );

  // B. User correction — drive the writer with a mocked CORRECTION fact.
  const { createMemoryWriter: createMockedWriter } = loadWriterWithMockedExtractor([
    { content: 'CORRECTION: User does not have brother named Daniel', confidence: 0.9 },
  ]);
  try {
    const writer = createMockedWriter({ memoryPool: appPool, logger: null });
    const writeResult = await writer.storeWorkingMemories({
      userMessage: "I don't have a brother named Daniel",
      pilotInstanceId: PILOT_A,
      userId: SENIOR_A,
      userRole: 'senior',
    });
    assert.equal(writeResult.stored, 1, 'writer stored the correction fact');
  } finally {
    clearMocks();
  }

  // C. Schema-level check: the Daniel row is now active=false,
  //    memory_status='SUPERSEDED'. The CORRECTION row is active=true.
  const superuser = new Client({ connectionString: DATABASE_URL });
  await superuser.connect();
  try {
    const danielRow = await superuser.query(
      "SELECT active, memory_status FROM memory_store WHERE content = $1",
      ["User's brother is named Daniel"]
    );
    assert.equal(danielRow.rowCount, 1, 'the Daniel row is still there (history-preserved)');
    assert.equal(danielRow.rows[0].active, false,
      'the Daniel row is deactivated by the correction');
    assert.equal(danielRow.rows[0].memory_status, 'SUPERSEDED',
      'the Daniel row carries memory_status=SUPERSEDED');

    const correctionRow = await superuser.query(
      "SELECT active, memory_status, provenance FROM memory_store WHERE content = $1",
      ['CORRECTION: User does not have brother named Daniel']
    );
    assert.equal(correctionRow.rowCount, 1, 'the CORRECTION row was stored');
    assert.equal(correctionRow.rows[0].active, true,
      'the CORRECTION row is active');
    // The writer inserts as WORKING_ACTIVE then promotes
    // high-confidence facts (>= 0.9) to VERIFIED — the CORRECTION
    // fact at confidence 0.9 qualifies, so VERIFIED is the final
    // state. WORKING_ACTIVE would also be retrievable (both pass
    // the listVisibleMemories WHERE clause).
    assert.ok(
      ['WORKING_ACTIVE', 'VERIFIED'].includes(correctionRow.rows[0].memory_status),
      `CORRECTION row memory_status must be retrievable; got ${correctionRow.rows[0].memory_status}`
    );
    assert.equal(correctionRow.rows[0].provenance, 'USER_STATED',
      'the CORRECTION row is provenance=USER_STATED');

    // The supersession + creation should each have produced exactly
    // one governance_audit_log entry of the right type.
    const updatedEvents = await superuser.query(
      "SELECT count(*)::int AS n FROM governance_audit_log WHERE event_type = 'memory.updated'"
    );
    assert.ok(updatedEvents.rows[0].n >= 1,
      'at least one memory.updated audit row was inserted (the deactivation)');
    const createdEvents = await superuser.query(
      "SELECT count(*)::int AS n FROM governance_audit_log WHERE event_type = 'memory.created'"
    );
    assert.ok(createdEvents.rows[0].n >= 2,
      'memory.created audit rows exist (seed + CORRECTION)');
  } finally {
    await superuser.end();
  }

  // D. Retrieval check: a fresh reader call must NOT return Daniel
  //    and MUST return the CORRECTION row.
  const post = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.equal(
    post.some((r) => r.content === "User's brother is named Daniel"),
    false,
    'post-correction: Daniel must NOT resurface in retrieval'
  );
  assert.ok(
    post.some((r) => r.content === 'CORRECTION: User does not have brother named Daniel'),
    'post-correction: the CORRECTION row appears in retrieval'
  );

  // Authority hierarchy check: the CORRECTION row carries
  // USER_CORRECTED authority and appears first in the ordered result.
  const correctionInRetrieval = post.find(
    (r) => r.content === 'CORRECTION: User does not have brother named Daniel'
  );
  assert.equal(correctionInRetrieval.authority_level, 'USER_CORRECTED',
    'CORRECTION row carries authority_level=USER_CORRECTED');
  assert.equal(post[0].authority_level, 'USER_CORRECTED',
    'USER_CORRECTED memories rank first in retrieval');

  // E. New-session check: close + reopen the pool (the closest
  //    process-restart simulation an in-process test can do) and
  //    confirm Daniel still doesn't resurrect.
  await closeMemoryPool(appPool);
  appPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
  const freshReader = createCompanionReader({ memoryPool: appPool });
  const newSession = await freshReader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.equal(
    newSession.some((r) => r.content === "User's brother is named Daniel"),
    false,
    'new session: Daniel must still not appear (supersession is persistent)'
  );
});

// ---------------------------------------------------------------
// Live-test regression: the user said "Correction: Daniel is not my
// brother" via chat and the extractor's existing patterns didn't
// match. No CORRECTION was generated, the seeded fact stayed canonical,
// and the model kept asserting "Daniel is your brother" on the next
// turn. This test runs through the REAL extractor (not a mock) to
// prove the natural-language phrasings are caught end-to-end.
// ---------------------------------------------------------------
test('natural-language correction phrasing supersedes the seeded fact', async () => {
  // Reload the real writer/extractor — the previous test polluted the
  // require cache with mocks.
  delete require.cache[require.resolve('../../src/memory/writer')];
  delete require.cache[require.resolve('../../src/memory/extractor')];
  const { createMemoryWriter: realWriter } = require('../../src/memory/writer');

  // Reuse appPool from the suite (it was reopened in test 1 step E).
  // Seed the affirmative fact through the same code path the chat
  // surface would use — extract "My brother is Daniel" via the real
  // extractor, then write via the real writer. This proves the
  // pipeline both ways.
  const writer = realWriter({ memoryPool: appPool, logger: null });
  const seedWrite = await writer.storeWorkingMemories({
    userMessage: 'My brother is Daniel',
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
  });
  assert.ok(seedWrite.stored >= 1, 'seed write stored at least one fact');

  // Pre-correction: the seeded "User's brother is named Daniel"
  // should be visible.
  const reader = createCompanionReader({ memoryPool: appPool });
  const pre = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.ok(
    pre.some((r) => r.content === "User's brother is named Daniel"),
    'pre-correction: brother-named-Daniel fact is visible'
  );

  // Apply the natural-language correction — exactly the phrasing
  // the live test failed on.
  const correctionWrite = await writer.storeWorkingMemories({
    userMessage: 'Correction: Daniel is not my brother',
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
  });
  assert.ok(correctionWrite.stored >= 1,
    'natural-language correction must produce at least one stored CORRECTION fact');

  // Verify the seeded affirmative fact is now SUPERSEDED.
  const superuser = new Client({ connectionString: DATABASE_URL });
  await superuser.connect();
  try {
    const seedAfter = await superuser.query(
      "SELECT active, memory_status FROM memory_store WHERE content = $1",
      ["User's brother is named Daniel"]
    );
    assert.ok(seedAfter.rowCount >= 1, 'seed row still present (history preserved)');
    const allSeeds = seedAfter.rows;
    // At least one of the matching rows must now be deactivated /
    // SUPERSEDED. (If the writer wrote multiple seeds across the
    // suite, only the latest needed deactivation for THIS correction
    // to work — but the natural-language correction targets the
    // brother-named-Daniel substring so all matching rows should be
    // hit by findActiveMemoriesContaining.)
    assert.ok(
      allSeeds.every((r) => r.active === false && r.memory_status === 'SUPERSEDED'),
      'every brother-named-Daniel row must be SUPERSEDED after the correction'
    );
  } finally {
    await superuser.end();
  }

  // Retrieval: the seeded fact MUST NOT appear. The CORRECTION row
  // MUST appear and rank first (USER_CORRECTED authority).
  const post = await reader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.equal(
    post.some((r) => r.content === "User's brother is named Daniel"),
    false,
    'post-correction: the seeded brother-named-Daniel fact must not surface in retrieval'
  );
  const correction = post.find(
    (r) => r.content.startsWith('CORRECTION:') && r.content.includes('Daniel')
  );
  assert.ok(correction, 'a CORRECTION row about Daniel must appear in retrieval');
  assert.equal(correction.authority_level, 'USER_CORRECTED');

  // New-session persistence — Daniel must still not resurrect.
  await closeMemoryPool(appPool);
  appPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
  const freshReader = createCompanionReader({ memoryPool: appPool });
  const newSession = await freshReader.readVisibleMemories({
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior', limit: 100,
  });
  assert.equal(
    newSession.some((r) => r.content === "User's brother is named Daniel"),
    false,
    'new session: the seeded fact remains SUPERSEDED across pools'
  );
});
