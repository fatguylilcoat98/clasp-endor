'use strict';
/*
 * Unit tests for the circle repository — Phase 3.
 *
 * No real DB; the pg client is faked. These tests run inside the
 * unit-tests CI job. The RLS contract is exercised separately in
 * tests/rls-contract/run-real.test.js against the real schema; this
 * file proves the JS layer's validation + INSERT/UPDATE shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupUserByEmail,
  insertCircleContact,
  listCircleContactsForSenior,
  setCircleContactScope,
  VALID_VISIBILITY_TIERS,
} = require('../../src/circle/repository');

const PILOT = '11111111-1111-1111-1111-111111111111';
const SENIOR = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const CONTACT = 'bbbbbbbb-2222-1111-1111-aaaaaaaaaaaa';
const sessionCtx = { pilotInstanceId: PILOT, userId: SENIOR, userRole: 'senior' };

function makeFakeClient(opts) {
  const o = opts || {};
  const queries = [];
  const lookupRows = o.lookupRows || [];
  const updateRows = o.updateRows || [{ id: 'updated' }];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params: params || [] });
      if (/FROM users/i.test(text)) {
        return { rows: lookupRows, rowCount: lookupRows.length };
      }
      if (/UPDATE circle_contacts/i.test(text)) {
        return { rows: updateRows, rowCount: updateRows.length };
      }
      if (/INSERT INTO circle_contacts/i.test(text)) {
        return {
          rows: [{ id: 'cccccccc-1111-1111-1111-cccccccccccc', created_at: new Date() }],
          rowCount: 1,
        };
      }
      if (/SELECT.*FROM circle_contacts/i.test(text)) {
        return {
          rows: o.listRows || [],
          rowCount: (o.listRows || []).length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ---- VALID_VISIBILITY_TIERS ----

test('VALID_VISIBILITY_TIERS only contains family_shared (password_locked excluded)', () => {
  assert.deepEqual(Array.from(VALID_VISIBILITY_TIERS).sort(), ['family_shared']);
});

// ---- lookupUserByEmail ----

test('lookupUserByEmail: rejects empty / non-string email', async () => {
  const client = makeFakeClient();
  await assert.rejects(() => lookupUserByEmail(client, sessionCtx, ''), /email is required/);
  await assert.rejects(() => lookupUserByEmail(client, sessionCtx, '   '), /email is required/);
  await assert.rejects(() => lookupUserByEmail(client, sessionCtx, 123), /email is required/);
});

test('lookupUserByEmail: normalizes (trim + lowercase) and queries pilot-scoped', async () => {
  const client = makeFakeClient({ lookupRows: [{ id: CONTACT, username: 'jill@test.example', role: 'family' }] });
  const r = await lookupUserByEmail(client, sessionCtx, '  JILL@test.example  ');
  assert.equal(r.id, CONTACT);
  assert.equal(r.username, 'jill@test.example');
  assert.equal(client.queries[0].params[0], PILOT);
  assert.equal(client.queries[0].params[1], 'jill@test.example');
});

test('lookupUserByEmail: returns null when no row matches', async () => {
  const client = makeFakeClient({ lookupRows: [] });
  const r = await lookupUserByEmail(client, sessionCtx, 'ghost@nowhere.test');
  assert.equal(r, null);
});

// ---- insertCircleContact ----

test('insertCircleContact: requires contactUserId', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, { visibilityLevels: [] }),
    /contactUserId is required/
  );
});

test('insertCircleContact: forbids adding yourself', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, { contactUserId: SENIOR, visibilityLevels: [] }),
    /cannot add yourself/
  );
});

test('insertCircleContact: rejects password_locked tier (out of scope)', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, {
      contactUserId: CONTACT,
      visibilityLevels: ['password_locked'],
    }),
    /"password_locked" not permitted/
  );
});

test('insertCircleContact: rejects unknown tier strings', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, {
      contactUserId: CONTACT,
      visibilityLevels: ['family_shared', 'mystery_tier'],
    }),
    /"mystery_tier" not permitted/
  );
});

test('insertCircleContact: rejects non-array visibilityLevels', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, { contactUserId: CONTACT, visibilityLevels: null }),
    /must be an array/
  );
  await assert.rejects(
    () => insertCircleContact(client, sessionCtx, { contactUserId: CONTACT, visibilityLevels: 'family_shared' }),
    /must be an array/
  );
});

test('insertCircleContact: empty visibilityLevels is the default-deny stub (still inserts the row)', async () => {
  const client = makeFakeClient();
  const r = await insertCircleContact(client, sessionCtx, {
    contactUserId: CONTACT,
    visibilityLevels: [],
  });
  assert.equal(r.id, 'cccccccc-1111-1111-1111-cccccccccccc');
  assert.deepEqual(r.visibilityLevels, []);
  // The permission_scope param is JSON with empty array — default-deny.
  const insertQ = client.queries.find((q) => /INSERT INTO circle_contacts/i.test(q.text));
  assert.equal(insertQ.params[3], JSON.stringify({ visibility_levels: [] }));
});

test('insertCircleContact: family_shared writes correct permission_scope JSON', async () => {
  const client = makeFakeClient();
  await insertCircleContact(client, sessionCtx, {
    contactUserId: CONTACT,
    visibilityLevels: ['family_shared'],
  });
  const insertQ = client.queries.find((q) => /INSERT INTO circle_contacts/i.test(q.text));
  assert.equal(insertQ.params[0], PILOT);
  assert.equal(insertQ.params[1], SENIOR);
  assert.equal(insertQ.params[2], CONTACT);
  assert.equal(insertQ.params[3], JSON.stringify({ visibility_levels: ['family_shared'] }));
});

test('insertCircleContact: dedupes + sorts visibilityLevels in the stored shape', async () => {
  const client = makeFakeClient();
  await insertCircleContact(client, sessionCtx, {
    contactUserId: CONTACT,
    visibilityLevels: ['family_shared', 'family_shared'],
  });
  const insertQ = client.queries.find((q) => /INSERT INTO circle_contacts/i.test(q.text));
  assert.equal(insertQ.params[3], JSON.stringify({ visibility_levels: ['family_shared'] }));
});

// ---- listCircleContactsForSenior ----

test('listCircleContactsForSenior: maps rows + tolerates missing/legacy permission_scope', async () => {
  const client = makeFakeClient({
    listRows: [
      {
        id: 'r1', contact_user_id: CONTACT, contact_username: 'jill@test.example',
        contact_role: 'family', permission_scope: { visibility_levels: ['family_shared'] },
        created_at: new Date('2024-01-01'),
      },
      {
        id: 'r2', contact_user_id: 'other', contact_username: 'alex@test.example',
        contact_role: 'caregiver', permission_scope: null,
        created_at: new Date('2024-01-02'),
      },
    ],
  });
  const rows = await listCircleContactsForSenior(client, sessionCtx);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].visibilityLevels, ['family_shared']);
  assert.deepEqual(rows[1].visibilityLevels, []);
});

// ---- setCircleContactScope ----

test('setCircleContactScope: requires id', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => setCircleContactScope(client, sessionCtx, '', ['family_shared']),
    /id is required/
  );
});

test('setCircleContactScope: empty array is soft-delete and is accepted', async () => {
  const client = makeFakeClient();
  const r = await setCircleContactScope(client, sessionCtx, 'r1', []);
  assert.deepEqual(r.visibilityLevels, []);
  const updateQ = client.queries.find((q) => /UPDATE circle_contacts/i.test(q.text));
  assert.equal(updateQ.params[3], JSON.stringify({ visibility_levels: [] }));
  // The pilot + senior gate is in the WHERE clause — no other user
  // can rewrite this row.
  assert.equal(updateQ.params[1], PILOT);
  assert.equal(updateQ.params[2], SENIOR);
});

test('setCircleContactScope: rejects password_locked even on UPDATE', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => setCircleContactScope(client, sessionCtx, 'r1', ['password_locked']),
    /"password_locked" not permitted/
  );
});

test('setCircleContactScope: not-found row throws', async () => {
  const client = makeFakeClient({ updateRows: [] });
  await assert.rejects(
    () => setCircleContactScope(client, sessionCtx, 'r1', ['family_shared']),
    /not found or not owned by caller/
  );
});
