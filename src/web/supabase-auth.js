'use strict';
/*
 * Supabase Auth REST wrappers.
 *
 * Server-to-server calls only. The browser never talks to Supabase
 * Auth directly — that would require shipping SUPABASE_ANON_KEY to
 * the client, and would split the auth flow across trust boundaries.
 * The client posts {email, password} to OUR /api/signup or /api/login
 * over HTTPS; we relay to Supabase, verify the returned JWT locally
 * (src/web/jwt-verify.js), JIT-provision the public.users row
 * (src/web/identity.js), and seal OUR HMAC session cookie.
 *
 * Endpoints used:
 *   POST ${SUPABASE_URL}/auth/v1/signup
 *     body: { email, password, data? }
 *     headers: apikey: ${SUPABASE_ANON_KEY}, Content-Type: application/json
 *     returns: { access_token, refresh_token, user, ... }  on success
 *              (or 422/400 with { code, msg } on failure)
 *
 *   POST ${SUPABASE_URL}/auth/v1/token?grant_type=password
 *     body: { email, password }
 *     headers: apikey + Content-Type
 *     returns: { access_token, refresh_token, user, ... }
 *
 * What this module does NOT do:
 *   - It does not log passwords. The password field is read from the
 *     request body, passed to the fetch call, and never re-emitted.
 *   - It does not echo Supabase error messages back to the browser.
 *     We map every failure to "invalid email or password" (login) or
 *     "signup failed" (signup), per the security invariant that
 *     login failure must not enumerate accounts.
 *   - It does not retry. A failed signup or login surfaces to the
 *     caller immediately. The browser shows a generic error.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function ensureConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('supabase-auth: config object required');
  }
  const { supabaseUrl, anonKey } = config;
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[^/]+$/.test(supabaseUrl.replace(/\/$/, ''))) {
    throw new Error('supabase-auth: supabaseUrl must be an https:// URL');
  }
  if (typeof anonKey !== 'string' || anonKey.length < 20) {
    throw new Error('supabase-auth: anonKey is required');
  }
  return {
    baseUrl: supabaseUrl.replace(/\/$/, ''),
    anonKey,
  };
}

function isHttpsUrl(s) {
  return typeof s === 'string' && /^https:\/\//.test(s);
}

async function postJsonWithTimeout(url, headers, body, timeoutMs) {
  if (!isHttpsUrl(url)) {
    throw new Error('supabase-auth: refusing non-HTTPS Supabase URL');
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* leave null */ }
    return { status: res.status, body: payload };
  } finally {
    clearTimeout(t);
  }
}

/*
 * createSupabaseAuthClient
 *   config: { supabaseUrl, anonKey, fetchTimeoutMs? }
 * Returns { signup({email, password}), login({email, password}) }.
 *
 * Both methods return { ok: true, accessToken, refreshToken, userId,
 * email } on success or { ok: false, status, code } on failure.
 * The `code` is a coarse class ('invalid_credentials', 'user_exists',
 * 'rate_limited', 'unavailable', 'malformed_response'), never the raw
 * Supabase message.
 */
function createSupabaseAuthClient(config) {
  const { baseUrl, anonKey } = ensureConfig(config);
  const timeoutMs = (config && config.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  };

  function classifySupabaseError(status, body) {
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'unavailable';
    // Supabase uses error_code / msg / error_description across versions.
    const code = (body && (body.error_code || body.code || '')).toString().toLowerCase();
    if (code.includes('already_registered') || code.includes('user_already_exists')) {
      return 'user_exists';
    }
    if (status === 400 || status === 401 || status === 403 || status === 422) {
      return 'invalid_credentials';
    }
    return 'unavailable';
  }

  function extractSuccess(body) {
    if (!body || typeof body !== 'object') return null;
    const accessToken = body.access_token;
    const refreshToken = body.refresh_token;
    const user = body.user;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (!user || typeof user !== 'object' || typeof user.id !== 'string') return null;
    return {
      accessToken,
      refreshToken: typeof refreshToken === 'string' ? refreshToken : null,
      userId: user.id,
      email: typeof user.email === 'string' ? user.email : null,
      emailConfirmed: !!(user.email_confirmed_at || user.confirmed_at),
    };
  }

  async function signup({ email, password }) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      return { ok: false, status: 400, code: 'invalid_credentials' };
    }
    let res;
    try {
      res = await postJsonWithTimeout(
        `${baseUrl}/auth/v1/signup`,
        headers,
        { email, password },
        timeoutMs,
      );
    } catch {
      return { ok: false, status: 0, code: 'unavailable' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, code: classifySupabaseError(res.status, res.body) };
    }
    const ok = extractSuccess(res.body);
    if (!ok) {
      // Supabase may 200 with a "confirmation_sent_at" body and NO
      // access_token when email confirmation is required. Treat this
      // as success-pending-confirmation; identity flow handles it.
      if (res.body && typeof res.body === 'object' && (res.body.confirmation_sent_at || (res.body.user && res.body.user.id))) {
        return {
          ok: true,
          confirmationPending: true,
          accessToken: null,
          refreshToken: null,
          userId: res.body.user && res.body.user.id ? res.body.user.id : null,
          email: res.body.user && res.body.user.email ? res.body.user.email : null,
          emailConfirmed: false,
        };
      }
      return { ok: false, status: res.status, code: 'malformed_response' };
    }
    return { ok: true, confirmationPending: false, ...ok };
  }

  async function login({ email, password }) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      return { ok: false, status: 400, code: 'invalid_credentials' };
    }
    let res;
    try {
      res = await postJsonWithTimeout(
        `${baseUrl}/auth/v1/token?grant_type=password`,
        headers,
        { email, password },
        timeoutMs,
      );
    } catch {
      return { ok: false, status: 0, code: 'unavailable' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, code: classifySupabaseError(res.status, res.body) };
    }
    const ok = extractSuccess(res.body);
    if (!ok) {
      return { ok: false, status: res.status, code: 'malformed_response' };
    }
    return { ok: true, confirmationPending: false, ...ok };
  }

  return Object.freeze({ signup, login });
}

module.exports = { createSupabaseAuthClient };
