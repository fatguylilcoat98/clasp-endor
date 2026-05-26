'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createIdentityResolver,
  bootstrapAdminEmailsFromEnv,
  normalizeEmail,
} = require('../../src/web/identity');

const PILOT = '11111111-1111-1111-1111-111111111111';
const AUTH_USER_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const AUTH_USER_B = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

function makeFakePool(initialRows) {
  // In-memory mock of the subset of pg.Pool surface the identity
  // resolver uses: { query }. Stores users rows so SELECT/INSERT/
  // UPDATE behavior is observable.
  const rows = initialRows.map((r) => ({ ...r }));
  let nextId = 1000;
  const queries = [];

  async function query(sql, params) {
    queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    // SELECT id, role, username FROM users WHERE auth_user_id = $1 AND pilot_instance_id = $2 LIMIT 1
    if (/^SELECT id, role, username FROM users WHERE auth_user_id = \$1 AND pilot_instance_id = \$2/i.test(s)) {
      const [authId, pid] = params;
      const found = rows.find((r) => r.auth_user_id === authId && r.pilot_instance_id === pid);
      return { rowCount: found ? 1 : 0, rows: found ? [{ id: found.id, role: found.role, username: found.username }] : [] };
    }

    // INSERT INTO users ... RETURNING id
    if (/^INSERT INTO users/i.test(s)) {
      const [pid, username, role, authId] = params;
      // Simulate the UNIQUE constraint on (pilot_instance_id, username).
      const collide = rows.find((r) => r.pilot_instance_id === pid && r.username === username);
      if (collide) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`;
      rows.push({ id, pilot_instance_id: pid, username, role, auth_user_id: authId });
      return { rowCount: 1, rows: [{ id }] };
    }

    // UPDATE users SET auth_user_id = $1 WHERE ... RETURNING id, role
    if (/^UPDATE users SET auth_user_id = \$1/i.test(s)) {
      const [authId, pid, username] = params;
      const target = rows.find(
        (r) => r.pilot_instance_id === pid && r.username === username && r.auth_user_id == null
      );
      if (!target) return { rowCount: 0, rows: [] };
      target.auth_user_id = authId;
      return { rowCount: 1, rows: [{ id: target.id, role: target.role }] };
    }

    throw new Error(`fake pool: unmocked query: ${s}`);
  }

  async function end() { /* noop */ }

  return { query, end, _rows: rows, _queries: queries };
}

// ---------------------------------------------------------------
// normalizeEmail + bootstrapAdminEmailsFromEnv
// ---------------------------------------------------------------

test('normalizeEmail accepts valid + rejects malformed', () => {
  assert.equal(normalizeEmail('jill@test.example'), 'jill@test.example');
  assert.equal(normalizeEmail('  Jill@Test.Example  '), 'jill@test.example');
  assert.equal(normalizeEmail('jill'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail('no@dot'), null);
});

test('bootstrapAdminEmailsFromEnv parses comma-separated', () => {
  const set = bootstrapAdminEmailsFromEnv('admin@x.com, OPS@y.com,bad-not-email, , extra@z.com');
  assert.ok(set.has('admin@x.com'));
  assert.ok(set.has('ops@y.com'));
  assert.ok(set.has('extra@z.com'));
  assert.equal(set.size, 3);
  assert.equal(bootstrapAdminEmailsFromEnv('').size, 0);
  assert.equal(bootstrapAdminEmailsFromEnv(undefined).size, 0);
});

// ---------------------------------------------------------------
// createIdentityResolver — happy path + edge cases
// ---------------------------------------------------------------

test('first-login: provisions a new senior user', async () => {
  const pool = makeFakePool([]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  const r = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'jill@test.example' });
  assert.equal(r.isNewUser, true);
  assert.equal(r.userRole, 'senior');
  assert.equal(r.email, 'jill@test.example');
  // user row was written with auth_user_id linked
  const row = pool._rows[0];
  assert.equal(row.auth_user_id, AUTH_USER_A);
  assert.equal(row.role, 'senior');
  assert.equal(row.username, 'jill@test.example');
});

test('first-login bootstrap admin email gets role=admin', async () => {
  const pool = makeFakePool([]);
  const admins = new Set(['boss@test.example']);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT, bootstrapAdminEmails: admins });
  const r = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'boss@test.example' });
  assert.equal(r.isNewUser, true);
  assert.equal(r.userRole, 'admin');
});

test('second login for same auth user returns the existing row, not a new one', async () => {
  const pool = makeFakePool([]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  const first = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'jill@test.example' });
  const second = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'jill@test.example' });
  assert.equal(second.isNewUser, false);
  assert.equal(second.userId, first.userId);
  assert.equal(pool._rows.length, 1, 'must NOT create a second row');
});

test('two distinct auth identities get two distinct public.users rows', async () => {
  const pool = makeFakePool([]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  const chris = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'chris@test.example' });
  const jill  = await resolver.resolveOrProvision({ authUserId: AUTH_USER_B, email: 'jill@test.example' });
  assert.notEqual(chris.userId, jill.userId, 'distinct auth identities must get distinct user UUIDs');
  assert.equal(pool._rows.length, 2);
});

test('legacy row with matching email + null auth_user_id is attached on first login', async () => {
  // Migration path: an existing public.users row whose `username` is
  // an email and whose auth_user_id is NULL gets the auth identity
  // ATTACHED on first matching signup (rather than colliding on the
  // UNIQUE(pilot, username) constraint). Strictly opt-in: only fires
  // when auth_user_id IS NULL.
  const pool = makeFakePool([
    { id: 'legacy-row-id', pilot_instance_id: PILOT, username: 'chris@test.example', role: 'senior', auth_user_id: null },
  ]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  const r = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'chris@test.example' });
  assert.equal(r.isNewUser, false);
  assert.equal(r.userId, 'legacy-row-id');
  assert.equal(pool._rows[0].auth_user_id, AUTH_USER_A);
});

test('username collision with row that ALREADY has an auth_user_id is rejected', async () => {
  // A row with auth_user_id != incoming = impersonation attempt.
  const pool = makeFakePool([
    { id: 'first-id', pilot_instance_id: PILOT, username: 'chris@test.example', role: 'senior', auth_user_id: 'preexisting-auth' },
  ]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  await assert.rejects(
    () => resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'chris@test.example' }),
    /unique constraint/
  );
});

test('invalid input is rejected before any DB call', async () => {
  const pool = makeFakePool([]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  await assert.rejects(() => resolver.resolveOrProvision({}), /authUserId/);
  await assert.rejects(() => resolver.resolveOrProvision({ authUserId: 'not-a-uuid', email: 'a@b.c' }), /authUserId/);
  await assert.rejects(() => resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'not-an-email' }), /email/);
  assert.equal(pool._queries.length, 0);
});

test('pilotInstanceId must be a UUID at construction', () => {
  const pool = makeFakePool([]);
  assert.throws(() => createIdentityResolver({ pool, pilotInstanceId: 'not-a-uuid' }), /pilotInstanceId/);
});

test('either pool or setupDatabaseUrl is required', () => {
  assert.throws(() => createIdentityResolver({ pilotInstanceId: PILOT }), /pool/);
});

test('email lookup is scoped by pilot_instance_id', async () => {
  // Same auth_user_id in two different pilots would have to live in
  // two different rows. The lookup MUST narrow by pilot to prevent
  // a cross-pilot resolution. (Currently a single-pilot test door,
  // so this is a forward-looking guarantee.)
  const pool = makeFakePool([
    { id: 'other-pilot-row', pilot_instance_id: '22222222-2222-2222-2222-222222222222', username: 'jill@test.example', role: 'senior', auth_user_id: AUTH_USER_A },
  ]);
  const resolver = createIdentityResolver({ pool, pilotInstanceId: PILOT });
  const r = await resolver.resolveOrProvision({ authUserId: AUTH_USER_A, email: 'jill@test.example' });
  // Because there is no row for THIS pilot, a new row is provisioned.
  assert.equal(r.isNewUser, true);
  assert.equal(pool._rows.length, 2);
  const ourRow = pool._rows.find((r) => r.pilot_instance_id === PILOT);
  assert.equal(ourRow.auth_user_id, AUTH_USER_A);
});
