'use strict';
/*
 * Test-door session cookie.
 *
 * Stateless HMAC-signed cookie carrying { userId, userRole,
 * displayName, companionLabel, issuedAt }. No DB session table, no
 * memory store of sessions. Process restart invalidates outstanding
 * cookies because the HMAC secret is process-bound.
 *
 * The cookie value format is `${b64url(payload)}.${b64url(signature)}`
 * — payload is the JSON body, signature is HMAC-SHA256(payload,
 * secret). Verification is constant-time.
 *
 * Hard rules:
 *   - The secret is required; no default. If missing, sealing throws.
 *   - The payload carries only the four identity fields plus issuedAt.
 *     It must never carry the persona, the API key, the DB URL, or any
 *     other secret.
 *   - userRole is restricted to 'senior' or 'admin' at the web layer.
 *     The conversation runtime's broader VALID_ROLES set is not
 *     reflected here on purpose — the test door only provisions those
 *     two users.
 *   - Expiry is checked on every verify; default lifetime 12h.
 */

const crypto = require('node:crypto');

const COOKIE_NAME = 'testdoor_session';
const DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ROLES = new Set(['senior', 'admin']);

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const norm = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(norm, 'base64');
}

function signPayload(payloadBytes, secret) {
  return crypto.createHmac('sha256', secret).update(payloadBytes).digest();
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'malformed';
  if (typeof payload.userId !== 'string' || !UUID_RE.test(payload.userId)) return 'userId';
  if (typeof payload.userRole !== 'string' || !ALLOWED_ROLES.has(payload.userRole)) return 'userRole';
  if (typeof payload.displayName !== 'string' || payload.displayName.length === 0) return 'displayName';
  if (payload.companionLabel !== null && typeof payload.companionLabel !== 'string') return 'companionLabel';
  if (typeof payload.issuedAt !== 'number' || !Number.isFinite(payload.issuedAt)) return 'issuedAt';
  return null;
}

function createSessionCodec(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createSessionCodec: options object is required');
  }
  const { secret } = options;
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createSessionCodec: secret must be a string of length >= 16');
  }
  const lifetimeMs = options.lifetimeMs || DEFAULT_LIFETIME_MS;

  function seal(payload) {
    const err = validatePayload(payload);
    if (err) throw new Error(`session seal: invalid ${err}`);
    const bodyBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = signPayload(bodyBytes, secret);
    return `${b64urlEncode(bodyBytes)}.${b64urlEncode(sig)}`;
  }

  function unseal(cookieValue, nowMs) {
    if (typeof cookieValue !== 'string') return null;
    const dot = cookieValue.indexOf('.');
    if (dot < 1 || dot === cookieValue.length - 1) return null;
    const bodyPart = cookieValue.slice(0, dot);
    const sigPart = cookieValue.slice(dot + 1);
    let bodyBytes;
    let sigBytes;
    try {
      bodyBytes = b64urlDecode(bodyPart);
      sigBytes = b64urlDecode(sigPart);
    } catch {
      return null;
    }
    const expected = signPayload(bodyBytes, secret);
    if (sigBytes.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(sigBytes, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(bodyBytes.toString('utf8'));
    } catch {
      return null;
    }
    if (validatePayload(payload)) return null;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (now - payload.issuedAt > lifetimeMs) return null;
    return payload;
  }

  return Object.freeze({ seal, unseal, cookieName: COOKIE_NAME });
}

function parseCookieHeader(header, name) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function buildSetCookie(name, value, options) {
  const opts = options || {};
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (opts.maxAgeSeconds) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  createSessionCodec,
  parseCookieHeader,
  buildSetCookie,
  buildClearCookie,
  COOKIE_NAME,
  DEFAULT_LIFETIME_MS,
};
