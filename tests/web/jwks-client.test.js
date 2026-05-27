'use strict';

/*
 * JWKS client tests — caching, stampede guard, cache-miss refetch,
 * stale-on-failure, kid removal on rotation.
 *
 * The client is tested with an injected `fetcher` so no real HTTP
 * calls happen. The fetcher records how many times it was invoked
 * and what it returned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJwksClient } = require('../../src/web/jwks-client');

const JWKS_URL = 'https://x.supabase.co/auth/v1/.well-known/jwks.json';

function jwk(kid) {
  return { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid, alg: 'ES256', use: 'sig' };
}

function makeFetcher(responsesQueue) {
  const calls = [];
  async function fetcher(url, _timeoutMs) {
    calls.push(url);
    const next = responsesQueue.shift();
    if (next === undefined) throw new Error('fetcher: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
  fetcher.calls = calls;
  return fetcher;
}

test('createJwksClient: validates options', () => {
  assert.throws(() => createJwksClient(null), /options object/);
  assert.throws(() => createJwksClient({}), /jwksUrl/);
  assert.throws(() => createJwksClient({ jwksUrl: '' }), /jwksUrl/);
});

test('getKey: fetches JWKS lazily on first call, returns the matching jwk', async () => {
  const fetcher = makeFetcher([{ keys: [jwk('k1'), jwk('k2')] }]);
  const client = createJwksClient({ jwksUrl: JWKS_URL, fetcher });
  assert.equal(fetcher.calls.length, 0, 'no fetch before first getKey');
  const k = await client.getKey('k1');
  assert.equal(k.kid, 'k1');
  assert.equal(fetcher.calls.length, 1);
});

test('getKey: caches across calls — does not refetch for known kid', async () => {
  const fetcher = makeFetcher([{ keys: [jwk('k1')] }]);
  const client = createJwksClient({ jwksUrl: JWKS_URL, fetcher });
  await client.getKey('k1');
  await client.getKey('k1');
  await client.getKey('k1');
  assert.equal(fetcher.calls.length, 1, 'only the first call fetches');
});

test('getKey: cache MISS rate-limited globally — repeat misses within minRefetchIntervalMs share a single refetch', async () => {
  // Global rate limit: once a refetch has happened, no further
  // refetches for ANY kid until minRefetchIntervalMs elapses. A
  // legitimate Supabase key rotation (rare; months apart) still
  // picks up the new kid on the next interval-permitted refetch.
  // A flood of garbage-kid tokens cannot hammer JWKS.
  const fetcher = makeFetcher([
    { keys: [jwk('k1')] },
  ]);
  const client = createJwksClient({
    jwksUrl: JWKS_URL,
    fetcher,
    minRefetchIntervalMs: 60_000,
  });
  const k1 = await client.getKey('k1');
  assert.equal(k1.kid, 'k1');
  assert.equal(fetcher.calls.length, 1);
  // k2 misses but the interval has not elapsed — no refetch.
  const k2 = await client.getKey('k2');
  assert.equal(k2, null);
  assert.equal(fetcher.calls.length, 1, 'rate-limit blocks the k2 refetch');
  // k3 also misses; still no refetch.
  const k3 = await client.getKey('k3');
  assert.equal(k3, null);
  assert.equal(fetcher.calls.length, 1, 'rate-limit still in effect');
});

test('getKey: cache MISS with minRefetchIntervalMs=0 always refetches', async () => {
  // Disabled rate limit (tests / local mode). Every miss issues a
  // fetch so a rotation lands immediately.
  const fetcher = makeFetcher([
    { keys: [jwk('k1')] },
    { keys: [jwk('k1'), jwk('k2')] },
  ]);
  const client = createJwksClient({
    jwksUrl: JWKS_URL,
    fetcher,
    minRefetchIntervalMs: 0,
  });
  const k1 = await client.getKey('k1');
  assert.equal(k1.kid, 'k1');
  const k2 = await client.getKey('k2');
  assert.equal(k2.kid, 'k2');
  assert.equal(fetcher.calls.length, 2);
});

test('getKey: stale-on-failure — cached key still returned if JWKS refetch fails', async () => {
  const fetcher = makeFetcher([
    { keys: [jwk('k1')] },
    new Error('jwks: 500'),
  ]);
  const client = createJwksClient({
    jwksUrl: JWKS_URL,
    fetcher,
    minRefetchIntervalMs: 0,
  });
  await client.getKey('k1');
  // Miss triggers refetch, which fails. k1 should still be returned
  // from the prior cache; the failed refetch must not wipe known keys.
  await client.getKey('k-unknown');
  const stillThere = await client.getKey('k1');
  assert.equal(stillThere.kid, 'k1', 'failed refetch must not evict known kids');
});

test('getKey: drops kids that disappear from a NEW successful fetch (rotation)', async () => {
  // First fetch: [k1, k2]. After rotation: [k2, k3]. The next miss-
  // triggered refetch updates the cache; k1 is no longer in the
  // response and must be dropped so a rotated-out key can no longer
  // verify tokens.
  const fetcher = makeFetcher([
    { keys: [jwk('k1'), jwk('k2')] },
    { keys: [jwk('k2'), jwk('k3')] },
  ]);
  const client = createJwksClient({
    jwksUrl: JWKS_URL,
    fetcher,
    minRefetchIntervalMs: 0,
  });
  await client.getKey('k1');
  const k3 = await client.getKey('k3'); // triggers refetch
  assert.equal(k3.kid, 'k3');
  // k1 must have been evicted by the new fetch.
  // Note: getKey for k1 might trigger another refetch — but the
  // interval guard above is 0, so we re-enter. The next fetch in
  // the queue is undefined → 'queue exhausted' error → stale-on-
  // failure path returns whatever cache has. After the previous
  // successful fetch, k1 was dropped, so result is null.
  const k1Again = await client.getKey('k1');
  assert.equal(k1Again, null, 'k1 must be evicted after rotation');
});

test('getKey: invalid kid (empty / non-string) returns null without fetching', async () => {
  const fetcher = makeFetcher([{ keys: [jwk('k1')] }]);
  const client = createJwksClient({ jwksUrl: JWKS_URL, fetcher });
  assert.equal(await client.getKey(''), null);
  assert.equal(await client.getKey(null), null);
  assert.equal(await client.getKey(undefined), null);
  assert.equal(fetcher.calls.length, 0, 'invalid kid must not trigger a fetch');
});

test('getKey: JWKS response missing kid on a key drops that key silently', async () => {
  const badJwk = { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' /* no kid */ };
  const fetcher = makeFetcher([{ keys: [jwk('k1'), badJwk] }]);
  const client = createJwksClient({ jwksUrl: JWKS_URL, fetcher });
  const k1 = await client.getKey('k1');
  assert.equal(k1.kid, 'k1');
});

test('getKey: JWKS response with empty keys array does NOT populate cache', async () => {
  const fetcher = makeFetcher([
    { keys: [] },
    { keys: [jwk('k1')] },
  ]);
  const client = createJwksClient({
    jwksUrl: JWKS_URL,
    fetcher,
    minRefetchIntervalMs: 0,
  });
  const first = await client.getKey('k1');
  assert.equal(first, null);
  // Next call beyond interval: cache miss → refetch → second response
  // populates the cache.
  const second = await client.getKey('k1');
  assert.equal(second.kid, 'k1');
});

test('getKey: concurrent calls for the same missing kid issue ONE refetch (stampede guard)', async () => {
  // Simulate 5 simultaneous getKey('k1') calls when the cache is
  // empty. The fetcher should be called exactly once; all 5 awaiters
  // resolve from the same fetch.
  let resolveFetch;
  const fetchPromise = new Promise((res) => { resolveFetch = res; });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return fetchPromise;
  };
  const client = createJwksClient({ jwksUrl: JWKS_URL, fetcher });
  const promises = [
    client.getKey('k1'),
    client.getKey('k1'),
    client.getKey('k1'),
    client.getKey('k1'),
    client.getKey('k1'),
  ];
  // Let the first call kick off the fetch.
  await new Promise((r) => setImmediate(r));
  resolveFetch({ keys: [jwk('k1')] });
  const results = await Promise.all(promises);
  assert.equal(calls, 1, 'only one fetch in flight despite 5 concurrent getKey calls');
  for (const r of results) assert.equal(r.kid, 'k1');
});
