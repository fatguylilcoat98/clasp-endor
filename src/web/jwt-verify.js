'use strict';
/*
 * JWT verification — HS256 (legacy Supabase shared secret) plus
 * RS256 / ES256 (Supabase asymmetric JWT signing keys, via JWKS).
 *
 * Why both algs: Supabase Auth historically signed access tokens with
 * HS256 using a per-project shared secret (SUPABASE_JWT_SECRET, the
 * "Legacy JWT Secret" in the dashboard). Projects that have enabled
 * JWT Signing Keys now sign with an asymmetric key — ES256 by default
 * or RS256 if configured — and publish the public keys at
 *   ${SUPABASE_URL}/auth/v1/.well-known/jwks.json
 * Tokens carry a `kid` header that selects which JWK to verify with.
 * The legacy HS256 secret cannot verify those tokens. If a project
 * has migrated, hand-rolled HS256-only verifiers fail every login.
 *
 * Why no SDK / no jsonwebtoken dep: the verification is still ~80
 * lines of node:crypto. Pulling a transitive dep for one verifier
 * widens the secret surface. We use the platform's HMAC + asymmetric
 * verify directly, with `dsaEncoding: 'ieee-p1363'` so node accepts
 * the JWS-format ES256 signature without manual r||s → DER conversion.
 *
 * What this verifies:
 *   1. Token has exactly three b64url segments separated by `.`.
 *   2. Header is JSON, alg in {'HS256', 'RS256', 'ES256'}, typ in
 *      {'JWT', undefined}. (Reject 'none' and any other alg — the
 *      rejection is the whole point: an attacker who can convince
 *      us to switch alg can forge tokens.)
 *   3. Signature verifies:
 *        - HS256: HMAC-SHA256 of `${header}.${payload}` with the
 *          shared secret, constant-time compare.
 *        - RS256: RSA-SHA256 against a public key resolved from
 *          getKey(kid).
 *        - ES256: ECDSA P-256 / SHA-256 against a public key resolved
 *          from getKey(kid). Signature is JWS r||s format; node verifies
 *          natively with dsaEncoding='ieee-p1363'.
 *   4. Claims: exp not past (with 30s skew tolerance), nbf not future,
 *      iss === expected Supabase project iss URL when provided.
 *
 * What this does NOT do:
 *   - Does not call out to /auth/v1/user. The signature is sufficient
 *     proof for our login event; we don't round-trip on every login.
 *   - Does not refresh expired tokens. Login flow gets a fresh token
 *     from Supabase; we never store the token, only the resolved
 *     auth_user_id from a successfully verified one.
 *   - Does not handle key rotation directly; the JWKS client does
 *     (cache + miss-triggered refetch).
 */

const crypto = require('node:crypto');

const ALLOWED_ALGS = new Set(['HS256', 'RS256', 'ES256']);
const DEFAULT_SKEW_SECONDS = 30;

function b64urlDecodeToBuffer(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('jwt: malformed segment');
  }
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

// Resolve a JWK to a node KeyObject for verify(). Accepts the JWK
// object as returned by JWKS endpoints. Throws on malformed JWK.
function jwkToPublicKey(jwk) {
  if (!jwk || typeof jwk !== 'object') {
    throw new Error('jwt: invalid jwk');
  }
  // crypto.createPublicKey supports format: 'jwk' since Node 16.
  // Throws on bad shape — we rewrap to keep error coarse.
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new Error('jwt: invalid jwk');
  }
}

function verifyHs256(signingInput, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf8')
    .digest();
  return constantTimeBufferEqual(signature, expected);
}

function verifyRs256(signingInput, signature, publicKey) {
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    publicKey,
    signature
  );
}

function verifyEs256(signingInput, signature, publicKey) {
  // ES256 signatures in JWS are 64 bytes of r||s (IEEE P1363). node's
  // crypto.verify defaults to DER, so we tell it the dsaEncoding so
  // it accepts the JWS bytes directly.
  return crypto.verify(
    'SHA256',
    Buffer.from(signingInput, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
}

/*
 * verifySupabaseJwt(token, options)
 *   token: the access_token string from Supabase Auth.
 *   options:
 *     secret           — required for HS256 tokens. Ignored for
 *                        RS256/ES256.
 *     getKey(kid)      — async or sync function that returns the JWK
 *                        object for the given key id. Required for
 *                        RS256/ES256 tokens.
 *     expectedIssuer   — optional. If provided, iss claim must match.
 *     nowMs            — optional. Defaults to Date.now(); test seam.
 *     skewSeconds      — optional. Defaults to 30.
 *
 * Returns the verified claims object on success. Throws on any
 * failure with a coarse, non-sensitive Error message — the same
 * message for every failure class so a caller's error response
 * doesn't help an attacker tune their next attempt.
 */
async function verifySupabaseJwt(token, options) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('jwt: invalid token');
  }
  if (!options || typeof options !== 'object') {
    throw new Error('jwt: options required');
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
    // Explicit alg gate. Rejects 'none' and any other alg.
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

  let ok = false;
  if (header.alg === 'HS256') {
    const secret = options.secret;
    if (typeof secret !== 'string' || secret.length < 16) {
      throw new Error('jwt: invalid token');
    }
    ok = verifyHs256(signingInput, signature, secret);
  } else {
    // RS256 or ES256 — require a JWKS provider.
    if (typeof options.getKey !== 'function') {
      throw new Error('jwt: invalid token');
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
      throw new Error('jwt: invalid token');
    }
    let jwk;
    try {
      jwk = await options.getKey(header.kid);
    } catch {
      throw new Error('jwt: invalid token');
    }
    if (!jwk) {
      throw new Error('jwt: invalid token');
    }
    let publicKey;
    try {
      publicKey = jwkToPublicKey(jwk);
    } catch {
      throw new Error('jwt: invalid token');
    }
    try {
      if (header.alg === 'RS256') {
        ok = verifyRs256(signingInput, signature, publicKey);
      } else {
        ok = verifyEs256(signingInput, signature, publicKey);
      }
    } catch {
      // node throws if signature bytes are the wrong length, etc.
      ok = false;
    }
  }

  if (!ok) {
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
