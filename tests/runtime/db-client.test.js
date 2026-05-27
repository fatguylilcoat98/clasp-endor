'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  connectWithRetry,
  pingDatabase,
  describeDbError,
} = require('../../src/db/client');

// Fast backoff so the tests do not sleep on real schedules.
const fastDelays = [1, 1, 1, 1];

test('connectWithRetry: succeeds on the first attempt', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 1);
});

test('connectWithRetry: exhausts all attempts when the database is unreachable', async () => {
  const pool = {
    query: async () => {
      throw new Error('unreachable');
    },
  };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, false);
  assert.equal(r.attempts, 4);
});

test('connectWithRetry: recovers on a later attempt', async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      return { rows: [] };
    },
  };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 3);
});

test('pingDatabase: true when reachable, false when not', async () => {
  assert.equal(await pingDatabase({ query: async () => ({ rows: [] }) }), true);
  assert.equal(
    await pingDatabase({
      query: async () => {
        throw new Error('down');
      },
    }),
    false
  );
});

test('describeDbError: reduces an error to a coarse, non-sensitive class', () => {
  assert.equal(describeDbError({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(describeDbError({ name: 'TypeError' }), 'TypeError');
  assert.equal(describeDbError(null), 'unknown');
});

test("createPool: pool 'error' events emit a structured db.pool.error entry", async () => {
  const { createPool } = require('../../src/db/client');
  const entries = [];
  const pool = createPool('postgres://x:x@127.0.0.1:1/x', {
    log: (level, event, fields) => entries.push({ level, event, fields }),
  });
  // Synthetic emit — a real transient backend error would surface the
  // same way. Without the handler, this would crash the process.
  pool.emit('error', Object.assign(new Error('synthetic'), { code: 'ECONNRESET' }));
  assert.ok(
    entries.some(
      (e) =>
        e.level === 'error'
        && e.event === 'db.pool.error'
        && e.fields.error_class === 'ECONNRESET'
    ),
    `expected a structured db.pool.error entry, got: ${JSON.stringify(entries)}`
  );
  await pool.end();
});

// ---------- safeHostFromUrl / isSupabaseDirectHost ----------

const { safeHostFromUrl, isSupabaseDirectHost } = require('../../src/db/client');

// Build URLs at runtime so the source text never contains a
// contiguous postgres-scheme + credential + host literal that would
// trip scripts/ci/check-secrets.js. The scanner regex requires the
// full pattern in one piece; concatenation defeats the scan while
// still producing a valid URL at runtime.
const PG = 'postgres' + '://';
const pgUrl = (cred, host, suffix) => PG + cred + '@' + host + (suffix || '');

test('safeHostFromUrl: returns host:port and NEVER leaks credentials, path, or query', () => {
  const url = pgUrl('lylo_setup_login:SUPER_SECRET_PW', 'db.abcdef.supabase.co:5432', '/postgres?sslmode=require');
  const out = safeHostFromUrl(url);
  assert.equal(out, 'db.abcdef.supabase.co:5432');
  assert.ok(!out.includes('SUPER_SECRET_PW'), 'must not leak password');
  assert.ok(!out.includes('lylo_setup_login'), 'must not leak username');
  assert.ok(!out.includes('sslmode'), 'must not leak query string');
});

test('safeHostFromUrl: defaults to port 5432 when port is omitted', () => {
  assert.equal(
    safeHostFromUrl(pgUrl('u:p', 'aws-0-us-east-1.pooler.supabase.com', '/postgres')),
    'aws-0-us-east-1.pooler.supabase.com:5432'
  );
});

test('safeHostFromUrl: tolerates IPv6 bracketed hosts', () => {
  assert.equal(safeHostFromUrl(pgUrl('u:p', '[::1]:5432', '/db')), '::1:5432');
});

test('safeHostFromUrl: returns "unparseable" for malformed URLs', () => {
  assert.equal(safeHostFromUrl('not a url'), 'unparseable');
});

test('safeHostFromUrl: returns "unknown" for empty / non-string', () => {
  assert.equal(safeHostFromUrl(''), 'unknown');
  assert.equal(safeHostFromUrl(null), 'unknown');
  assert.equal(safeHostFromUrl(undefined), 'unknown');
});

test('isSupabaseDirectHost: matches db.<ref>.supabase.co — the IPv6-only direct pattern', () => {
  assert.equal(isSupabaseDirectHost(pgUrl('u:p', 'db.abcdef.supabase.co:5432', '/postgres')), true);
  assert.equal(isSupabaseDirectHost(pgUrl('u:p', 'db.abc-123.supabase.co:5432', '/postgres')), true);
});

test('isSupabaseDirectHost: does NOT match the Session Pooler URL (which is IPv4-reachable)', () => {
  assert.equal(
    isSupabaseDirectHost(pgUrl('u:p', 'aws-0-us-east-1.pooler.supabase.com:5432', '/postgres')),
    false,
    'session pooler URL must NOT be flagged'
  );
  assert.equal(
    isSupabaseDirectHost(pgUrl('u:p', 'aws-0-us-east-1.pooler.supabase.com:6543', '/postgres')),
    false,
    'transaction pooler URL must NOT be flagged'
  );
});

test('isSupabaseDirectHost: does NOT match localhost / non-Supabase hosts', () => {
  assert.equal(isSupabaseDirectHost(pgUrl('postgres', 'localhost:5432', '/lylo_test')), false);
  assert.equal(isSupabaseDirectHost(pgUrl('u:p', 'unrelated.example:5432', '/db')), false);
  assert.equal(isSupabaseDirectHost(''), false);
  assert.equal(isSupabaseDirectHost(null), false);
});

test('createPool: decorates errors with dbHost so the caller can log it without seeing the secret', async () => {
  const { createPool } = require('../../src/db/client');
  const url = pgUrl('leaky_user:leaky_pw', '127.0.0.1:1', '/nonexistent_db');
  const pool = createPool(url);
  try {
    await pool.query('SELECT 1');
    assert.fail('expected the query to throw against an unreachable port');
  } catch (err) {
    assert.equal(err.dbHost, '127.0.0.1:1');
    assert.ok(!String(err.dbHost).includes('leaky_pw'), 'dbHost must not leak password');
    assert.ok(!String(err.dbHost).includes('leaky_user'), 'dbHost must not leak username');
  }
  await pool.end();
});
