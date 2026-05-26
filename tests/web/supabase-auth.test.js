'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseAuthClient } = require('../../src/web/supabase-auth');

const VALID_URL = 'https://test.supabase.co';
const VALID_KEY = 'a-supabase-anon-key-of-reasonable-length';

function withMockFetch(responder, fn) {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    return responder(url, init);
  };
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

test('refuses non-https Supabase URL at construction', () => {
  assert.throws(
    () => createSupabaseAuthClient({ supabaseUrl: 'http://insecure.supabase.co', anonKey: VALID_KEY }),
    /https/
  );
  assert.throws(
    () => createSupabaseAuthClient({ supabaseUrl: 'ftp://other', anonKey: VALID_KEY }),
    /https/
  );
});

test('requires anonKey at construction', () => {
  assert.throws(
    () => createSupabaseAuthClient({ supabaseUrl: VALID_URL }),
    /anonKey/
  );
});

test('signup success returns userId, accessToken, refreshToken', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    (url, init) => {
      assert.equal(url, 'https://test.supabase.co/auth/v1/signup');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.apikey, VALID_KEY);
      const body = JSON.parse(init.body);
      assert.equal(body.email, 'jill@test.example');
      return jsonResponse(200, {
        access_token: 'access-jwt',
        refresh_token: 'refresh',
        user: { id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', email: 'jill@test.example', email_confirmed_at: '2026-01-01' },
      });
    },
    async () => {
      const res = await client.signup({ email: 'jill@test.example', password: 'hunter2hunter2' });
      assert.equal(res.ok, true);
      assert.equal(res.userId, 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa');
      assert.equal(res.accessToken, 'access-jwt');
      assert.equal(res.email, 'jill@test.example');
      assert.equal(res.confirmationPending, false);
      assert.equal(res.emailConfirmed, true);
    }
  );
});

test('signup with email-confirmation required returns confirmationPending=true', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(200, {
      confirmation_sent_at: '2026-01-01',
      user: { id: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', email: 'pending@test.example' },
    }),
    async () => {
      const res = await client.signup({ email: 'pending@test.example', password: 'hunter2hunter2' });
      assert.equal(res.ok, true);
      assert.equal(res.confirmationPending, true);
      assert.equal(res.accessToken, null);
      assert.equal(res.userId, 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb');
      assert.equal(res.emailConfirmed, false);
    }
  );
});

test('signup with user_already_exists is classified as user_exists', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(422, { error_code: 'user_already_exists', msg: 'User already registered' }),
    async () => {
      const res = await client.signup({ email: 'dup@test.example', password: 'hunter2hunter2' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'user_exists');
    }
  );
});

test('login success returns userId + accessToken', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    (url, init) => {
      assert.equal(url, 'https://test.supabase.co/auth/v1/token?grant_type=password');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.equal(body.email, 'chris@test.example');
      return jsonResponse(200, {
        access_token: 'access-jwt-chris',
        refresh_token: 'refresh-chris',
        user: { id: 'cccccccc-3333-3333-3333-cccccccccccc', email: 'chris@test.example', email_confirmed_at: '2026-01-01' },
      });
    },
    async () => {
      const res = await client.login({ email: 'chris@test.example', password: 'hunter2hunter2' });
      assert.equal(res.ok, true);
      assert.equal(res.userId, 'cccccccc-3333-3333-3333-cccccccccccc');
      assert.equal(res.accessToken, 'access-jwt-chris');
    }
  );
});

test('login with wrong password returns invalid_credentials (uniform error)', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(400, { error_description: 'Invalid login credentials' }),
    async () => {
      const res = await client.login({ email: 'chris@test.example', password: 'wrong' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'invalid_credentials');
    }
  );
});

test('login with non-existent email also returns invalid_credentials (no enumeration)', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(400, { error_description: 'Invalid login credentials' }),
    async () => {
      const res = await client.login({ email: 'doesnotexist@test.example', password: 'whatever' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'invalid_credentials');
    }
  );
});

test('login rate-limited returns rate_limited', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(429, { msg: 'Too many requests' }),
    async () => {
      const res = await client.login({ email: 'x@y.com', password: 'whatever' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'rate_limited');
    }
  );
});

test('Supabase 5xx returns unavailable', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => jsonResponse(503, { msg: 'service unavailable' }),
    async () => {
      const res = await client.login({ email: 'x@y.com', password: 'whatever' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unavailable');
    }
  );
});

test('network error returns unavailable', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  await withMockFetch(
    () => { throw new Error('network down'); },
    async () => {
      const res = await client.login({ email: 'x@y.com', password: 'whatever' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unavailable');
    }
  );
});

test('non-string credentials are rejected before any network call', async () => {
  const client = createSupabaseAuthClient({ supabaseUrl: VALID_URL, anonKey: VALID_KEY });
  let networkCalled = false;
  await withMockFetch(
    () => { networkCalled = true; return jsonResponse(200, {}); },
    async () => {
      const res1 = await client.login({ email: null, password: 'whatever' });
      const res2 = await client.signup({ email: 'x@y.com', password: null });
      assert.equal(res1.ok, false);
      assert.equal(res2.ok, false);
      assert.equal(networkCalled, false, 'must not contact Supabase with malformed input');
    }
  );
});
