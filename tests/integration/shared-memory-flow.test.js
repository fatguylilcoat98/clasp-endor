'use strict';
/*
 * Shared-memory operational flow — proves the multi-step
 * grant / revoke transition end-to-end through the production
 * API surface (withMemoryContext + withCircleContext), against
 * the real schema.
 *
 * The scenario the user asked to be exercised explicitly:
 *
 *   1. Senior creates one PRIVATE memory and one FAMILY_SHARED
 *      memory (insertPrivateMemory / insertSharedMemory).
 *   2. A new family contact is added with EMPTY visibility scope
 *      (default-deny stub).
 *   3. Contact reads — sees nothing: default-deny holds.
 *   4. Senior grants 'family_shared' via setCircleContactScope.
 *   5. Contact reads — sees ONLY the family_shared row (the
 *      private row remains hidden).
 *   6. Senior revokes by setCircleContactScope([]).
 *   7. Contact reads — sees nothing again. Revocation is
 *      immediate at the next read; no stale visibility.
 *
 * The test asserts each transition step. Each phase runs in its
 * OWN withMemoryContext / withCircleContext, so we exercise the
 * pool acquisition + COMMIT cycle that the real HTTP path uses
 * (writes are committed; subsequent reads see them).
 *
 * Identifiers are reused from tests/rls-contract/fixtures.sql so
 * the seeded users (SENIOR_A, plus a fresh NEW_FAMILY user we
 * provision as superuser) live in PILOT_A alongside the existing
 * fixtures.
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
const {
  createCirclePool,
  closeCirclePool,
  withCircleContext,
} = require('../../src/circle');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
// A fresh family-role user we provision so the test isn't reusing
// the fixture's FAMILY_A (which is already in the circle with
// family_shared seeded). This lets the test prove transitions on a
// CLEAN circle row.
const NEW_FAMILY = 'aaaaaaaa-bbbb-2222-1111-aaaaaaaaaaaa';

let memoryPool;
let circlePool;
let bootstrapClient;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL must be set');

  bootstrapClient = new Client({ connectionString: DATABASE_URL });
  await bootstrapClient.connect();
  await bootstrapClient.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await bootstrapClient.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  await bootstrapClient.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  // Provision the new family contact as superuser (the registration
  // flow lives elsewhere; this test isn't about provisioning).
  await bootstrapClient.query(
    'INSERT INTO users (id, pilot_instance_id, username, role) '
      + 'VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [NEW_FAMILY, PILOT_A, 'new-family-flow@test.example', 'family']
  );

  memoryPool = createMemoryPool(LYLO_APP_DATABASE_URL, { max: 3 });
  circlePool = createCirclePool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (memoryPool) await closeMemoryPool(memoryPool);
  if (circlePool) await closeCirclePool(circlePool);
  if (bootstrapClient) await bootstrapClient.end();
});

// Each test below operates on freshly-inserted memory rows so they
// don't entangle with the fixture-seeded memories. Tests rely on
// CONTENT strings rather than ids; the inserts return ids if needed.

async function asSenior(fn) {
  return await withMemoryContext(
    memoryPool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    fn
  );
}
async function asFamilyMemory(fn) {
  return await withMemoryContext(
    memoryPool,
    { pilotInstanceId: PILOT_A, userId: NEW_FAMILY, userRole: 'family' },
    fn
  );
}
async function asSeniorCircle(fn) {
  return await withCircleContext(
    circlePool,
    { pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior' },
    fn
  );
}

// =====================================================================
// Step 1: senior creates one private memory and one family_shared memory.
// =====================================================================

test('shared-memory-flow: senior creates one private + one family_shared memory', async () => {
  const result = await asSenior(async (ctx) => {
    const priv = await ctx.insertPrivateMemory({
      content: 'flow-private — only the owner should see this',
      provenance: 'USER_STATED',
    });
    const shared = await ctx.insertSharedMemory({
      content: 'flow-shared — visible to circle members with family_shared',
      provenance: 'USER_STATED',
    });
    return { privId: priv.id, sharedId: shared.id };
  });
  assert.ok(result.privId);
  assert.ok(result.sharedId);
  assert.notEqual(result.privId, result.sharedId);
});

// =====================================================================
// Step 2 + 3: senior adds NEW_FAMILY to circle with empty scope; contact
// sees neither row (default-deny). Proves that adding a circle contact
// with no grants doesn't open visibility — the grant has to be explicit.
// =====================================================================

test('shared-memory-flow: senior adds contact with empty scope; contact sees no rows from senior (default-deny)', async () => {
  // Ensure NEW_FAMILY is not already in the circle from a prior run.
  await bootstrapClient.query(
    'DELETE FROM circle_contacts WHERE senior_user_id = $1 AND contact_user_id = $2',
    [SENIOR_A, NEW_FAMILY]
  );
  await asSeniorCircle(async (ctx) => {
    await ctx.insertCircleContact({
      contactUserId: NEW_FAMILY,
      visibilityLevels: [], // default-deny stub
    });
  });
  const rows = await asFamilyMemory((ctx) => ctx.listVisibleMemories({ limit: 100 }));
  const ownerIds = rows.map((r) => r.owning_user_id);
  assert.ok(!ownerIds.includes(SENIOR_A),
    'family contact with empty scope sees NO rows from the senior');
});

// =====================================================================
// Step 4 + 5: senior grants 'family_shared' via setCircleContactScope;
// contact now sees the family_shared row but NOT the private row.
// =====================================================================

test('shared-memory-flow: granting family_shared opens visibility — contact sees flow-shared but NOT flow-private', async () => {
  // Find the circle row id we just inserted (still rolled back? No —
  // withCircleContext commits on success). We look it up via the
  // listCircleContactsForSenior call.
  const contacts = await asSeniorCircle((ctx) => ctx.listCircleContactsForSenior());
  const newRow = contacts.find((c) => c.contactUserId === NEW_FAMILY);
  assert.ok(newRow, 'the inserted circle row must be listable');

  await asSeniorCircle(async (ctx) => {
    await ctx.setCircleContactScope(newRow.id, ['family_shared']);
  });

  const rows = await asFamilyMemory((ctx) => ctx.listVisibleMemories({ limit: 100 }));
  const contents = rows.map((r) => r.content);
  assert.ok(
    contents.some((c) => c && c.includes('flow-shared')),
    'after grant, contact sees the senior\'s flow-shared row'
  );
  assert.ok(
    !contents.some((c) => c && c.includes('flow-private')),
    'after grant, contact still does NOT see the senior\'s flow-private row'
  );
});

// =====================================================================
// Step 6 + 7: senior revokes by setCircleContactScope([]); contact
// loses visibility immediately on next read. No stale visibility.
// =====================================================================

test('shared-memory-flow: revoking (setCircleContactScope to []) closes visibility immediately on next read', async () => {
  const contacts = await asSeniorCircle((ctx) => ctx.listCircleContactsForSenior());
  const row = contacts.find((c) => c.contactUserId === NEW_FAMILY);
  assert.ok(row);

  await asSeniorCircle(async (ctx) => {
    await ctx.setCircleContactScope(row.id, []);
  });

  const rowsAfter = await asFamilyMemory((ctx) => ctx.listVisibleMemories({ limit: 100 }));
  const contents = rowsAfter.map((r) => r.content);
  assert.ok(
    !contents.some((c) => c && c.includes('flow-shared')),
    'after revoke, the flow-shared row must NOT surface in the contact\'s read'
  );
  assert.ok(
    !contents.some((c) => c && c.includes('flow-private')),
    'after revoke, the flow-private row still does NOT surface (sanity)'
  );
});

// =====================================================================
// Regression: re-grant after revoke restores visibility. Proves the
// grant flag is the only gate — once toggled back on, the same row
// becomes visible without re-inserting the memory.
// =====================================================================

test('shared-memory-flow: re-grant after revoke restores visibility (regression: scope is the only gate)', async () => {
  const contacts = await asSeniorCircle((ctx) => ctx.listCircleContactsForSenior());
  const row = contacts.find((c) => c.contactUserId === NEW_FAMILY);
  assert.ok(row);

  await asSeniorCircle(async (ctx) => {
    await ctx.setCircleContactScope(row.id, ['family_shared']);
  });
  const rowsAgain = await asFamilyMemory((ctx) => ctx.listVisibleMemories({ limit: 100 }));
  const contents = rowsAgain.map((r) => r.content);
  assert.ok(
    contents.some((c) => c && c.includes('flow-shared')),
    'after re-grant, the flow-shared row becomes visible again — no re-INSERT needed'
  );
});

// =====================================================================
// Regression: senior's private memory remains invisible to the contact
// at every step of the flow, regardless of scope state. Proves the
// PRIVATE tier is never grantable through circle_contacts.
// =====================================================================

test('shared-memory-flow: private tier is NEVER reachable by the contact regardless of scope (private is owner-only forever)', async () => {
  // Step the scope through [], ['family_shared'], [] and confirm the
  // private row never surfaces in the contact's read.
  const contacts = await asSeniorCircle((ctx) => ctx.listCircleContactsForSenior());
  const row = contacts.find((c) => c.contactUserId === NEW_FAMILY);
  assert.ok(row);
  for (const scope of [[], ['family_shared'], []]) {
    await asSeniorCircle(async (ctx) => {
      await ctx.setCircleContactScope(row.id, scope);
    });
    const memories = await asFamilyMemory((ctx) => ctx.listVisibleMemories({ limit: 100 }));
    const contents = memories.map((r) => r.content);
    assert.ok(
      !contents.some((c) => c && c.includes('flow-private')),
      `private row must not surface for scope=${JSON.stringify(scope)}`
    );
  }
});
