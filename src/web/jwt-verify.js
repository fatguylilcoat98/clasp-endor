'use strict';
/*
 * JWT verification — HS256 only, with Supabase's symmetric secret.
 *
 * Why HS256 and not RS256: Supabase Auth signs its access tokens with
 * a symmetric HMAC key (SUPABASE_JWT_SECRET). The same secret is the
 * verification key. We don't need a JWK fetch loop or asymmetric
 * verifier; HS256 is correct for the Supabase flow.
 *
 * Why no SDK / no jsonwebtoken dep: the verification is ~30 lines.
 * Pulling in a transitive dep for one verifier widens the secret
 * surface. node:crypto HMAC is fine.
 *
 * What this verifies:
 *   1. Token has exactly three b64url segments separated by `.`.
 *   2. Header is JSON, alg === 'HS256', typ in {'JWT', undefined}.
 *      (Reject 'none' and any asymmetric alg — the rejection is the
 *      whole point: an attacker who can convince us to switch alg
 *      can forge tokens.)
 *   3. Signature is HMAC-SHA256 of `${header}.${payload}` with the
 *      shared secret, compared in constant time.
 *   4. Claims: exp not past (with 30s skew tolerance), nbf not future,
 *      iss === expected Supabase project iss URL when provided.
 *
 * What this does NOT do:
 *   - Does not call out to the Supabase /auth/v1/user endpoint. The
 *     JWT signature is sufficient proof for our login event; we
 *     don't want to round-trip on every login.
 *   - Does not refresh expired tokens. Login flow gets a fresh token
 *     from Supabase; we never store the token, only the resolved
 *     auth_user_id from a successfully verified one.
 *   - Does not handle JWK rotation. If SUPABASE_JWT_SECRET is
 *     rotated, in-flight tokens fail verification. Acceptable for
 *     test door; for production we'd add a key-rotation window.
 */

const crypto = require('node:crypto');

const ALLOWED_ALGS = new Set(['HS256']);
const DEFAULT_SKEW_SECONDS = 30;

function b64urlDecodeToBuffer(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('jwt: malformed segment');
  }
  // base64url → base64
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) {
    throw new Error('jwt: invalid b64url characters');
  }
  return Buffer.from(b64, 'base64');
}

function b64urlDecodeToJson(s) {
  const buf = b64urlDecodeToBuffer(s);
  let obj;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('jwt: segment is not valid JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('jwt: segment did not decode to a JSON object');
  }
  return obj;
}

function constantTimeBufferEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/*
 * verifySupabaseJwt(token, options)
 *   token: the access_token string from Supabase Auth.
 *   options:
 *     secret           (required)  — SUPABASE_JWT_SECRET.
 *     expectedIssuer   (optional)  — e.g. `${SUPABASE_URL}/auth/v1`.
 *                                    If provided, iss claim must match.
 *     nowMs            (optional)  — defaults to Date.now(); test seam.
 *     skewSeconds      (optional)  — defaults to 30.
 *
 * Returns the verified claims object on success. Throws on any
 * failure with a coarse, non-sensitive Error message — the same
 * message for every failure class so a caller's error response
 * doesn't help an attacker tune their next attempt.
 */
function verifySupabaseJwt(token, options) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('jwt: invalid token');
  }
  if (!options || typeof options !== 'object') {
    throw new Error('jwt: options required');
  }
  const secret = options.secret;
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('jwt: server secret missing or too short');
  }
  const expectedIssuer = options.expectedIssuer;
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const skewSeconds = typeof options.skewSeconds === 'number' ? options.skewSeconds : DEFAULT_SKEW_SECONDS;

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt: invalid token');
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  try {
    header = b64urlDecodeToJson(headerB64);
  } catch {
    throw new Error('jwt: invalid token');
  }
  if (!ALLOWED_ALGS.has(header.alg)) {
    // Explicit alg gate. Rejects 'none' and any asymmetric alg.
    throw new Error('jwt: invalid token');
  }
  if (header.typ && header.typ !== 'JWT') {
    throw new Error('jwt: invalid token');
  }

  let signature;
  try {
    signature = b64urlDecodeToBuffer(sigB64);
  } catch {
    throw new Error('jwt: invalid token');
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf8')
    .digest();

  if (!constantTimeBufferEqual(signature, expected)) {
    throw new Error('jwt: invalid token');
  }

  let claims;
  try {
    claims = b64urlDecodeToJson(payloadB64);
  } catch {
    throw new Error('jwt: invalid token');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof claims.exp === 'number') {
    if (nowSeconds > claims.exp + skewSeconds) {
      throw new Error('jwt: invalid token');
    }
  }
  if (typeof claims.nbf === 'number') {
    if (nowSeconds + skewSeconds < claims.nbf) {
      throw new Error('jwt: invalid token');
    }
  }
  if (expectedIssuer && claims.iss !== expectedIssuer) {
    throw new Error('jwt: invalid token');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('jwt: invalid token');
  }

  return claims;
}

module.exports = { verifySupabaseJwt };
