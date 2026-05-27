'use strict';
/*
 * JWKS client — fetches and caches Supabase's JWT signing keys.
 *
 * Supabase publishes the public half of its asymmetric JWT signing
 * keys at ${SUPABASE_URL}/auth/v1/.well-known/jwks.json. Each access
 * token's header carries a `kid` that selects which key signed it.
 * Keys can be rotated; old `kid`s remain in JWKS for the rotation
 * window so in-flight tokens still verify.
 *
 * This client:
 *   1. Lazily fetches the JWKS on first getKey() call.
 *   2. Caches the result in-process, keyed by `kid`.
 *   3. On a cache miss (unknown `kid`), refetches — but at most
 *      once per minRefetchIntervalMs across ALL kids. This is the
 *      DoS defence: a flood of tokens with fabricated kids cannot
 *      hammer Supabase's JWKS endpoint. A legitimate key rotation
 *      still picks up the new kid on its first arrival, because
 *      legitimate rotations are sparse compared to the rate limit.
 *      A concurrent burst of logins for the same missing kid rides
 *      a single in-flight fetch via the stampede guard.
 *   4. Falls back to a stale cache hit if the latest fetch failed.
 *      A network blip should not break login for keys we already
 *      know.
 *
 * Hard rules:
 *   - The JWKS URL must be https:// in production. We allow http://
 *     only for localhost / 127.0.0.1 / ::1 so the test door can run
 *     against a mock fixture without TLS.
 *   - Response must be `{ keys: [...] }` with `kid` on every JWK.
 *     Anything else is dropped.
 *   - We do NOT trust an arbitrary `kid` — only kids that are in
 *     the JWKS we fetched. A token carrying a never-seen kid never
 *     verifies.
 *
 * Test seam: pass `fetcher` in options to inject a fake fetch
 * function. The default fetcher uses node:https + a 4s timeout.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MIN_REFETCH_INTERVAL_MS = 5 * 1000;

function isLocalUrl(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function defaultFetcher(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      reject(new Error('jwks: invalid url'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('jwks: invalid url scheme'));
      return;
    }
    if (parsed.protocol === 'http:' && !isLocalUrl(urlString)) {
      reject(new Error('jwks: refusing http:// to non-local host'));
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`jwks: http ${res.statusCode}`));
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(body);
          } catch {
            reject(new Error('jwks: invalid json'));
          }
        });
        res.on('error', () => reject(new Error('jwks: response error')));
      }
    );
    req.on('error', () => reject(new Error('jwks: request error')));
    req.on('timeout', () => {
      req.destroy(new Error('jwks: timeout'));
    });
    req.end();
  });
}

function normalizeJwks(body) {
  if (!body || typeof body !== 'object') return [];
  const keys = Array.isArray(body.keys) ? body.keys : [];
  return keys.filter(
    (k) => k && typeof k === 'object' && typeof k.kid === 'string' && k.kid.length > 0
  );
}

/*
 * createJwksClient(options)
 *   options:
 *     jwksUrl                 — https URL of the JWKS endpoint.
 *     fetcher                 — optional. (url, timeoutMs) => Promise<json>.
 *     timeoutMs               — optional. Per-fetch timeout. Default 4000.
 *     minRefetchIntervalMs    — optional. Default 5000.
 *     log                     — optional. (level, event, fields) callback.
 *
 * Returns { getKey, _state } where _state is for tests.
 */
function createJwksClient(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createJwksClient: options object is required');
  }
  const { jwksUrl } = options;
  if (typeof jwksUrl !== 'string' || jwksUrl.length === 0) {
    throw new Error('createJwksClient: jwksUrl is required');
  }
  const fetcher = options.fetcher || defaultFetcher;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  // `||` would swallow explicit 0 — use typeof so callers can disable
  // the rate limit by passing 0 (test seam).
  const minRefetchIntervalMs = typeof options.minRefetchIntervalMs === 'number'
    ? options.minRefetchIntervalMs
    : DEFAULT_MIN_REFETCH_INTERVAL_MS;
  const log = typeof options.log === 'function' ? options.log : () => {};

  // Cache: kid → jwk. Single Map for the lifetime of this client.
  // Stale entries are preserved across failed refetches so a transient
  // JWKS endpoint failure doesn't break known kids.
  const cache = new Map();
  // Global last refetch attempt time. Refetches are rate-limited
  // across all kids to bound the load on Supabase's JWKS endpoint.
  let lastFetchAttemptMs = 0;
  let inFlight = null;

  async function refetch() {
    // Stampede guard: if a fetch is in flight, ride that one.
    if (inFlight) return inFlight;
    lastFetchAttemptMs = Date.now();
    inFlight = (async () => {
      try {
        const body = await fetcher(jwksUrl, timeoutMs);
        const keys = normalizeJwks(body);
        if (keys.length === 0) {
          log('warn', 'jwks.empty', {});
          return;
        }
        // Replace cache entries from the response. Keep any stale
        // entries that weren't in the new JWKS — Supabase keeps old
        // kids in JWKS during rotation, but if a kid disappears from
        // the response we drop it on the NEXT successful fetch so
        // the rotation window is honoured.
        const fresh = new Set();
        for (const jwk of keys) {
          cache.set(jwk.kid, jwk);
          fresh.add(jwk.kid);
        }
        for (const k of Array.from(cache.keys())) {
          if (!fresh.has(k)) cache.delete(k);
        }
      } catch (err) {
        log('warn', 'jwks.fetch_failed', { error_class: err && err.message ? err.message : 'error' });
        // Keep the existing cache — stale-on-failure.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function getKey(kid) {
    if (typeof kid !== 'string' || kid.length === 0) return null;
    if (cache.has(kid)) return cache.get(kid);

    // Cache miss. If a fetch is already in flight, ride it — it
    // might populate this kid for free (stampede guard for
    // concurrent logins).
    if (inFlight) {
      await inFlight;
      return cache.get(kid) || null;
    }

    // No fetch in flight. Global rate limit: refetch only if
    // enough time has passed since the last attempt (or if we've
    // never fetched). `>=` so minInterval=0 means "always refetch."
    const now = Date.now();
    if (lastFetchAttemptMs === 0 || now - lastFetchAttemptMs >= minRefetchIntervalMs) {
      await refetch();
    }
    return cache.get(kid) || null;
  }

  return Object.freeze({
    getKey,
    _state: { cache, refetch },
  });
}

module.exports = { createJwksClient };
