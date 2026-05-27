'use strict';
/*
 * Unit tests for the memory repository — GM-18 hardening:
 *   - audit eventType is locked to the EVENT_TYPES vocabulary
 *   - insertPrivateMemory rejects content > MAX_CONTENT_LENGTH bytes
 *     with a non-content-revealing error
 *
 * No real DB; the pg client is faked. These tests run inside the
 * unit-tests CI job alongside transaction.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { insertAuditEvent, EVENT_TYPES } = require('../../src/memory/audit');
const { insertPrivateMemory, insertSharedMemory, MAX_CONTENT_LENGTH } = require('../../src/memory/repository');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const sessionCtx = { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' };

function makeFakeClient() {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params: params || [] });
      // Return a synthetic id for RETURNING clauses so insertPrivateMemory
      // can complete past the INSERT.
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb', created_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ---- audit vocabulary lock (OQ-18.3) ----

test('insertAuditEvent: accepts every value in EVENT_TYPES', async () => {
  const client = makeFakeClient();
  for (const eventType of Object.values(EVENT_TYPES)) {
    await insertAuditEvent(client, sessionCtx, { eventType, outcome: 'allowed' });
  }
});

test('insertAuditEvent: rejects an unknown eventType — vocabulary is locked', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertAuditEvent(client, sessionCtx, { eventType: 'memory.shar', outcome: 'allowed' }),
    /eventType must be one of/
  );
  assert.equal(client.queries.length, 0, 'no INSERT must have been attempted');
});

test('insertAuditEvent: rejects an empty / missing eventType', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertAuditEvent(client, sessionCtx, { eventType: '', outcome: 'allowed' }),
    /eventType must be one of/
  );
  await assert.rejects(
    () => insertAuditEvent(client, sessionCtx, { outcome: 'allowed' }),
    /eventType must be one of/
  );
});

test('insertAuditEvent: rejects an unknown outcome', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () =>
      insertAuditEvent(client, sessionCtx, {
        eventType: EVENT_TYPES.MEMORY_LIST,
        outcome: 'speculative',
      }),
    /outcome must be one of/
  );
});

// ---- content max-length (OQ-18.4 / OQ-18.5) ----

test('insertPrivateMemory: MAX_CONTENT_LENGTH is 65536 bytes (the GM-18 lock)', () => {
  assert.equal(MAX_CONTENT_LENGTH, 65536);
});

test('insertPrivateMemory: accepts content at the byte limit', async () => {
  const client = makeFakeClient();
  const content = 'x'.repeat(MAX_CONTENT_LENGTH); // ASCII → 1 byte/char
  const r = await insertPrivateMemory(client, sessionCtx, { content, provenance: 'USER_STATED' });
  assert.ok(r.id);
});

test('insertPrivateMemory: rejects content over the byte limit', async () => {
  const client = makeFakeClient();
  const content = 'x'.repeat(MAX_CONTENT_LENGTH + 1);
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content, provenance: 'USER_STATED' }),
    /content exceeds maximum length/
  );
  assert.equal(client.queries.length, 0, 'no DB query must have been issued');
});

test('insertPrivateMemory: rejects multi-byte content that exceeds the byte limit even though the JS string length is shorter', async () => {
  // U+1F600 GRINNING FACE is 4 bytes in UTF-8 / 2 JS code units.
  // Half the byte limit in faces = 8192 faces = 32768 JS chars, but
  // 32768 bytes — under the cap. So we craft a string that fits in
  // JS chars but spills in UTF-8 bytes.
  const client = makeFakeClient();
  const face = '\u{1F600}';
  // Length in JS code units: MAX_CONTENT_LENGTH / 2 (under cap as JS
  // chars). Length in bytes: MAX_CONTENT_LENGTH * 2 (over cap).
  const count = MAX_CONTENT_LENGTH / 2;
  const content = face.repeat(count);
  // Sanity-check the construction.
  assert.equal(content.length, count * 2, 'JS string length sanity');
  assert.equal(Buffer.byteLength(content, 'utf8'), count * 4, 'byte length sanity');
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content, provenance: 'USER_STATED' }),
    /content exceeds maximum length/
  );
});

test('insertPrivateMemory: the rejection error reports length + limit but NEVER echoes the content', async () => {
  const client = makeFakeClient();
  const secret = 'SECRET_MEMORY_CONTENT_'.repeat(4000); // ~88 KB
  let caught;
  try {
    await insertPrivateMemory(client, sessionCtx, { content: secret, provenance: 'USER_STATED' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /content exceeds maximum length/);
  assert.match(caught.message, /\d+\s*>\s*65536/);
  assert.equal(caught.message.includes('SECRET_MEMORY_CONTENT'), false, 'error message must not echo content');
});

// ---- other validations preserved ----

test('insertPrivateMemory: rejects bad provenance', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content: 'ok', provenance: 'GOSSIP' }),
    /provenance must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('insertPrivateMemory: rejects empty / non-string content', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content: '', provenance: 'USER_STATED' }),
    /content must be a non-empty string/
  );
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content: '   ', provenance: 'USER_STATED' }),
    /content must be a non-empty string/
  );
  await assert.rejects(
    () => insertPrivateMemory(client, sessionCtx, { content: 123, provenance: 'USER_STATED' }),
    /content must be a non-empty string/
  );
});

// ---- Phase 2: insertSharedMemory (family_shared tier) ----

test('insertPrivateMemory: INSERT statement carries visibility_level=$5 with value "private"', async () => {
  const client = makeFakeClient();
  await insertPrivateMemory(client, sessionCtx, { content: 'hi', provenance: 'USER_STATED' });
  const insertQ = client.queries.find((q) => /INSERT\s+INTO\s+memory_store/i.test(q.text));
  assert.ok(insertQ, 'an INSERT must have been issued');
  // params[4] = visibility_level (1-indexed param $5)
  assert.equal(insertQ.params[4], 'private');
});

test('insertSharedMemory: INSERT statement carries visibility_level "family_shared"', async () => {
  const client = makeFakeClient();
  await insertSharedMemory(client, sessionCtx, { content: 'family note', provenance: 'USER_STATED' });
  const insertQ = client.queries.find((q) => /INSERT\s+INTO\s+memory_store/i.test(q.text));
  assert.ok(insertQ);
  assert.equal(insertQ.params[4], 'family_shared');
});

test('insertSharedMemory: still pairs with a single audit row in the same call sequence', async () => {
  const client = makeFakeClient();
  await insertSharedMemory(client, sessionCtx, { content: 'family note', provenance: 'USER_STATED' });
  const inserts = client.queries.filter((q) => /INSERT\s+INTO/i.test(q.text));
  // One memory_store INSERT + one governance_audit_log INSERT
  assert.equal(inserts.length, 2);
});

test('insertSharedMemory: same validation as insertPrivateMemory — content, provenance, length', async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () => insertSharedMemory(client, sessionCtx, { content: '', provenance: 'USER_STATED' }),
    /content must be a non-empty string/
  );
  await assert.rejects(
    () => insertSharedMemory(client, sessionCtx, { content: 'ok', provenance: 'GOSSIP' }),
    /provenance must be one of/
  );
  await assert.rejects(
    () => insertSharedMemory(client, sessionCtx, { content: 'x'.repeat(MAX_CONTENT_LENGTH + 1), provenance: 'USER_STATED' }),
    /content exceeds maximum length/
  );
});
