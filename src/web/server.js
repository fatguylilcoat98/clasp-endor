'use strict';
/*
 * Test-door HTTP server.
 *
 * Stdlib `http` only. The web layer is uncovered by the existing
 * src/runtime, src/conversation, src/companion, src/memory, src/actors
 * and src/governance boundary scans, so HTTP framework imports here
 * are intentional and isolated.
 *
 * Routes:
 *   GET  /                  → public/index.html
 *   GET  /app.js            → public/app.js
 *   GET  /app.css           → public/app.css
 *   GET  /healthz           → liveness probe (200)
 *   POST /api/signup        → Supabase signup → JIT-provision user → seal cookie
 *   POST /api/login         → Supabase login → resolve user → seal cookie
 *   POST /api/chat          → classify + actor.execute (real model)
 *   GET  /api/admin/recent  → ring buffer (admin only)
 *   GET  /api/admin/memories→ read-only memory inspector (admin only;
 *                             RLS-narrowed to whatever the admin can see)
 *   GET  /api/admin/governance-events → recent governance_audit_log
 *                             rows (admin only; RLS-narrowed)
 *   GET  /api/_debug/identity → per-session identity + memory metadata
 *                             snapshot. 404 unless LYLO_DEBUG_IDENTITY=
 *                             true. Returns NO memory content — only
 *                             owning_user_id prefixes + tiers — so the
 *                             operator can confirm session isolation
 *                             without leaking memory text.
 *   GET  /api/circle/contacts        → list caller's circle
 *   POST /api/circle/contacts        → add by email + visibility scope
 *   POST /api/circle/contacts/scope  → update scope (or empty = revoke)
 *   POST /api/logout        → clear session cookie
 *
 * Hard rules:
 *   - Real user messages are never logged. Only metadata.
 *   - Passwords are never logged. The request body containing them is
 *     read once, passed to Supabase, never re-emitted.
 *   - The model response is never logged. Only the character count.
 *   - The session cookie never carries persona, API key, or auth token.
 *     Only { userId, userRole, displayName, companionLabel, issuedAt }.
 *   - Login / signup failures return uniform errors — no account
 *     enumeration. supabase-auth.js classifies; we map all "bad
 *     credentials" cases to the same response.
 *   - Admin-only endpoints fail with 403 for non-admin sessions.
 *   - The mold's substrate is not touched.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCookieHeader,
  buildSetCookie,
  buildClearCookie,
  COOKIE_NAME,
} = require('./session');
const { describeErrClass } = require('./wiring');
const { verifySupabaseJwt } = require('./jwt-verify');
const { normalizeEmail, maskEmail } = require('./identity');

// LYLO_DEBUG_IDENTITY=true turns on a layered identity diagnostic
// trace. Each chat turn emits a sequence of structured log events
// stitched together by `trace_id` so an operator investigating a
// suspected identity-contamination bug can see, in one place:
//
//   - the resolved authenticated identity (auth_user_id → public.users.id),
//   - the cookie-derived session identity at chat time,
//   - the constructed companionConfig that goes into the prompt,
//   - the memory count + first 3 memory ids + their authority levels,
//   - a SHA-256 fingerprint of the system prompt + identity excerpt.
//
// Off by default. Logs never include memory content, user message
// content, model response content, JWTs, JWK material, or anything
// the production privacy invariants forbid.
const DEBUG_IDENTITY = String(process.env.LYLO_DEBUG_IDENTITY || '').toLowerCase() === 'true';

function newTraceId() {
  return (Date.now().toString(36)
    + '-' + Math.random().toString(36).slice(2, 10));
}

function debugIdentity(log, event, fields) {
  if (!DEBUG_IDENTITY) return;
  log('info', `identity_debug.${event}`, fields || {});
}

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 8192;
const MAX_DISPLAY_NAME_LEN = 64;
const MAX_COMPANION_LABEL_LEN = 64;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;
const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC_FILES = Object.freeze({
  '/':         { rel: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { rel: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/app.js':   { rel: 'public/app.js',     type: 'application/javascript; charset=utf-8' },
  '/app.css':  { rel: 'public/app.css',    type: 'text/css; charset=utf-8' },
});

function jsonResponse(res, statusCode, body, extraHeaders) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' },
    extraHeaders || {}
  );
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

function textResponse(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
  });
  res.end(body);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err && err.message === 'payload_too_large') {
      const e = new Error('payload too large');
      e.userClass = 'payload_too_large';
      throw e;
    }
    const e = new Error('body read failed');
    e.userClass = 'bad_request';
    throw e;
  }
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const e = new Error('body must be a JSON object');
      e.userClass = 'bad_request';
      throw e;
    }
    return parsed;
  } catch (err) {
    if (err && err.userClass) throw err;
    const e = new Error('body is not valid JSON');
    e.userClass = 'bad_request';
    throw e;
  }
}

function normalizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_DISPLAY_NAME_LEN ? trimmed.slice(0, MAX_DISPLAY_NAME_LEN) : trimmed;
}

function normalizeCompanionLabel(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_COMPANION_LABEL_LEN
    ? trimmed.slice(0, MAX_COMPANION_LABEL_LEN)
    : trimmed;
}

function validatePassword(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length < MIN_PASSWORD_LEN || raw.length > MAX_PASSWORD_LEN) return null;
  return raw;
}

function loadStatic(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  return fs.readFileSync(abs);
}

/*
 * createTestDoorServer
 *
 * Options:
 *   repoRoot           — absolute path to the clasp-endor repo root.
 *   pilotInstanceId    — UUID of the single test-door pilot.
 *   sessionCodec       — session.createSessionCodec instance.
 *   wiring             — wiring.createTestDoorWiring instance.
 *   recent             — recent.createRecentBuffer instance.
 *   supabaseAuth       — supabase-auth.createSupabaseAuthClient instance.
 *   identity           — identity.createIdentityResolver instance.
 *   supabaseJwtSecret  — HS256 secret used to verify legacy tokens.
 *                        May be unused if the project signs with
 *                        asymmetric keys; we still require it so
 *                        either signing scheme is accepted without
 *                        a redeploy.
 *   jwtKeyLookup       — (kid) => Promise<jwk|null>. Resolves the
 *                        JWK for a given key id. Used for RS256 /
 *                        ES256 tokens issued via Supabase JWT
 *                        signing keys. Production wiring builds
 *                        this from createJwksClient.
 *   expectedJwtIssuer  — string, the expected `iss` claim on the JWT.
 *   log                — (level, event, fields) callback.
 *   secureCookie       — boolean; tests pass false, production true.
 */
function createTestDoorServer(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createTestDoorServer: options object is required');
  }
  const {
    repoRoot, pilotInstanceId, sessionCodec, wiring, recent,
    supabaseAuth, identity, supabaseJwtSecret, jwtKeyLookup, expectedJwtIssuer, log,
  } = options;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('createTestDoorServer: repoRoot is required');
  }
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('createTestDoorServer: pilotInstanceId must be a UUID');
  }
  if (!sessionCodec || typeof sessionCodec.seal !== 'function') {
    throw new Error('createTestDoorServer: sessionCodec is required');
  }
  if (!wiring || typeof wiring.handleChat !== 'function') {
    throw new Error('createTestDoorServer: wiring with handleChat is required');
  }
  if (typeof wiring.listMemoriesForInspector !== 'function') {
    throw new Error('createTestDoorServer: wiring.listMemoriesForInspector is required');
  }
  if (typeof wiring.listGovernanceEvents !== 'function') {
    throw new Error('createTestDoorServer: wiring.listGovernanceEvents is required');
  }
  if (typeof wiring.listCircleContacts !== 'function'
      || typeof wiring.addCircleContact !== 'function'
      || typeof wiring.setCircleContactPermissions !== 'function') {
    throw new Error('createTestDoorServer: wiring must expose circle CRUD (list/add/setPermissions)');
  }
  if (!recent || typeof recent.record !== 'function') {
    throw new Error('createTestDoorServer: recent buffer is required');
  }
  if (!supabaseAuth || typeof supabaseAuth.signup !== 'function' || typeof supabaseAuth.login !== 'function') {
    throw new Error('createTestDoorServer: supabaseAuth client with signup+login is required');
  }
  if (!identity || typeof identity.resolveOrProvision !== 'function') {
    throw new Error('createTestDoorServer: identity resolver is required');
  }
  if (typeof supabaseJwtSecret !== 'string' || supabaseJwtSecret.length < 16) {
    throw new Error('createTestDoorServer: supabaseJwtSecret is required');
  }
  if (typeof jwtKeyLookup !== 'function') {
    throw new Error('createTestDoorServer: jwtKeyLookup function is required');
  }
  if (typeof expectedJwtIssuer !== 'string' || expectedJwtIssuer.length === 0) {
    throw new Error('createTestDoorServer: expectedJwtIssuer is required');
  }
  if (typeof log !== 'function') {
    throw new Error('createTestDoorServer: log callback is required');
  }
  const secureCookie = !!options.secureCookie;

  function getSession(req) {
    const raw = parseCookieHeader(req.headers.cookie, COOKIE_NAME);
    if (!raw) return null;
    return sessionCodec.unseal(raw);
  }

  function buildSessionCookie(payload) {
    const cookieValue = sessionCodec.seal(payload);
    return buildSetCookie(COOKIE_NAME, cookieValue, {
      maxAgeSeconds: SESSION_LIFETIME_SECONDS,
      secure: secureCookie,
    });
  }

  /*
   * sealAndRespond:
   * given a verified auth identity + caller-supplied profile fields,
   * resolve / JIT-provision the public.users row, seal the session
   * cookie, and respond. Shared by /api/signup and /api/login.
   *
   * Failure-uniformity rule: any failure inside the identity step
   * surfaces as a single coarse 502 "internal" — we do not surface
   * which step failed to the browser.
   */
  async function sealAndRespond({
    res, eventType, authUserId, email, displayName, companionLabel, confirmationPending,
  }) {
    if (confirmationPending) {
      // Email-confirmation required — Supabase issued no access_token,
      // so we cannot resolve the public.users row yet. The user must
      // confirm their email and then log in.
      log('info', `${eventType}.pending_confirmation`, {
        pilot_instance_id: pilotInstanceId,
      });
      return jsonResponse(res, 200, {
        ok: true,
        confirmationPending: true,
        message: 'Check your email to confirm your account, then log in.',
      });
    }

    let resolved;
    try {
      resolved = await identity.resolveOrProvision({ authUserId, email });
    } catch (err) {
      // Decorate the failure log with whichever network-level
      // detail the underlying pg / net error carried, plus the
      // pool's safe host (set by src/db/client.js#createPool).
      // No credentials in any field — host is parsed from the URL
      // and address/port come from node's net layer on connection
      // errors (ENETUNREACH, ECONNREFUSED, ETIMEDOUT).
      log('warn', `${eventType}.identity_failed`, {
        error_class: describeErrClass(err),
        db_host: err && err.dbHost,
        address: err && err.address,
        port: err && err.port,
      });
      return jsonResponse(res, 502, { error: 'unable to complete sign-in' });
    }

    const cookie = buildSessionCookie({
      userId: resolved.userId,
      userRole: resolved.userRole,
      displayName: displayName || resolved.displayName,
      companionLabel,
      issuedAt: Date.now(),
    });

    log('info', `${eventType}.completed`, {
      pilot_instance_id: pilotInstanceId,
      user_id: resolved.userId,
      role: resolved.userRole,
      is_new_user: resolved.isNewUser,
    });

    debugIdentity(log, 'auth.resolved', {
      pilot_instance_id: pilotInstanceId,
      event_type: eventType,
      // Full auth_user_id is metadata (Supabase auth.users.id), not a
      // secret. Logged in full so the operator can spot duplicates
      // across two account login traces.
      auth_user_id: typeof authUserId === 'string' ? authUserId : null,
      // Masked email — distinguishes accounts in log lines without
      // exposing the full address. Two distinct emails produce two
      // distinct masked forms (different head/tld combinations).
      email_masked: maskEmail(email),
      resolved_user_id: resolved.userId,
      resolved_role: resolved.userRole,
      resolved_display_name_length: typeof resolved.displayName === 'string' ? resolved.displayName.length : 0,
      signup_display_name_length: typeof displayName === 'string' ? displayName.length : 0,
      companion_label_length: typeof companionLabel === 'string' ? companionLabel.length : 0,
      companion_label_is_null: companionLabel === null,
      is_new_user: resolved.isNewUser,
    });

    return jsonResponse(
      res, 200,
      {
        ok: true,
        confirmationPending: false,
        displayName: displayName || resolved.displayName,
        userRole: resolved.userRole,
        companionLabel,
        isAdmin: resolved.userRole === 'admin',
        isNewUser: resolved.isNewUser,
      },
      { 'Set-Cookie': cookie }
    );
  }

  async function handleSignup(req, res) {
    const body = await parseJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    const displayName = normalizeDisplayName(body.displayName);
    const companionLabel = normalizeCompanionLabel(body.companionName);

    if (!email || !password) {
      // Uniform "invalid input" error. Do not specify which field.
      return jsonResponse(res, 400, { error: 'email and password are required (password must be 8+ chars)' });
    }
    if (!displayName) {
      return jsonResponse(res, 400, { error: 'displayName is required' });
    }

    const auth = await supabaseAuth.signup({ email, password });
    if (!auth.ok) {
      if (auth.code === 'rate_limited') {
        return jsonResponse(res, 429, { error: 'too many requests, try again in a minute' });
      }
      if (auth.code === 'unavailable') {
        return jsonResponse(res, 502, { error: 'sign-in service unavailable, try again' });
      }
      // For user_exists and invalid_credentials, return a uniform
      // generic error. Do NOT surface "this email already exists" —
      // that's an enumeration vector.
      log('info', 'web.signup.rejected', { code: auth.code });
      return jsonResponse(res, 400, { error: 'could not create account with that email and password' });
    }

    return sealAndRespond({
      res,
      eventType: 'web.signup',
      authUserId: auth.userId,
      email: auth.email || email,
      displayName,
      companionLabel,
      confirmationPending: !!auth.confirmationPending,
    });
  }

  async function handleLogin(req, res) {
    const body = await parseJsonBody(req);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    const displayName = normalizeDisplayName(body.displayName); // optional override

    if (!email || !password) {
      return jsonResponse(res, 400, { error: 'email and password are required' });
    }

    const auth = await supabaseAuth.login({ email, password });
    if (!auth.ok) {
      if (auth.code === 'rate_limited') {
        return jsonResponse(res, 429, { error: 'too many requests, try again in a minute' });
      }
      if (auth.code === 'unavailable') {
        return jsonResponse(res, 502, { error: 'sign-in service unavailable, try again' });
      }
      log('info', 'web.login.rejected', { code: auth.code });
      // Uniform error — same response for missing account vs wrong
      // password, no enumeration.
      return jsonResponse(res, 401, { error: 'invalid email or password' });
    }

    // Verify the access_token's signature locally before trusting
    // the user identity. Belt-and-suspenders: Supabase already gave
    // us the user.id, but verifying the JWT we received proves the
    // response wasn't tampered with in transit.
    try {
      const claims = await verifySupabaseJwt(auth.accessToken, {
        secret: supabaseJwtSecret,
        getKey: jwtKeyLookup,
        expectedIssuer: expectedJwtIssuer,
      });
      if (claims.sub !== auth.userId) {
        log('warn', 'web.login.jwt_user_mismatch', {});
        return jsonResponse(res, 401, { error: 'invalid email or password' });
      }
    } catch (err) {
      log('warn', 'web.login.jwt_verification_failed', { error_class: describeErrClass(err) });
      return jsonResponse(res, 401, { error: 'invalid email or password' });
    }

    return sealAndRespond({
      res,
      eventType: 'web.login',
      authUserId: auth.userId,
      email: auth.email || email,
      displayName,
      companionLabel: null,
      confirmationPending: false,
    });
  }

  async function handleChat(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    const body = await parseJsonBody(req);
    const userMessage = typeof body.message === 'string' ? body.message : '';
    if (userMessage.trim().length === 0) {
      return jsonResponse(res, 400, { error: 'message is required' });
    }
    const byteLength = Buffer.byteLength(userMessage, 'utf8');
    if (byteLength > MAX_MESSAGE_BYTES) {
      return jsonResponse(res, 413, {
        error: `message too long (${byteLength} > ${MAX_MESSAGE_BYTES} bytes)`,
      });
    }

    // Phase 2: per-turn visibility hint. 'private' (default) or
    // 'family_shared'. password_locked is explicitly rejected — it
    // requires a vault unlock flow that is out of scope.
    let visibilityHint = body.visibilityHint;
    if (visibilityHint === undefined || visibilityHint === null || visibilityHint === '') {
      visibilityHint = 'private';
    }
    if (visibilityHint !== 'private' && visibilityHint !== 'family_shared') {
      return jsonResponse(res, 400, {
        error: 'visibilityHint must be "private" or "family_shared"',
      });
    }

    let bundle;
    const traceId = newTraceId();
    try {
      const companionConfig = {
        name: session.companionLabel || 'Assistant',
        persona: 'You are a helpful and friendly AI companion.'
      };

      // Layered identity-debug trace. Every event in this chat turn
      // shares `trace_id` so a grep on the operator's logs surfaces
      // the full identity story for one request in one place.
      // No memory content, message content, or response content
      // is logged here — only structural metadata.
      debugIdentity(log, 'chat.session_view', {
        trace_id: traceId,
        pilot_instance_id: pilotInstanceId,
        session_user_id: session.userId,
        session_user_role: session.userRole,
        session_display_name_length: typeof session.displayName === 'string' ? session.displayName.length : 0,
        session_companion_label_length: typeof session.companionLabel === 'string' ? session.companionLabel.length : 0,
        session_companion_label_value: session.companionLabel,
        session_issued_at: session.issuedAt,
        visibility_hint: visibilityHint,
        message_byte_length: byteLength,
      });
      debugIdentity(log, 'chat.companion_config', {
        trace_id: traceId,
        companion_name: companionConfig.name,
        companion_persona_length: companionConfig.persona.length,
      });

      bundle = await wiring.handleChat({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        userMessage,
        companionConfig,
        visibilityHint,
        traceId,
      });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.chat.error', {
        role: session.userRole,
        message_bytes: byteLength,
        error_class: errorClass,
      });
      recent.record({
        userRole: session.userRole,
        outcome: 'error',
        decision: null,
        reason: null,
        memoryCount: null,
        responseChars: null,
        errorClass,
      });
      return jsonResponse(res, 502, {
        error: 'model call failed',
        errorClass,
      });
    }

    recent.record({
      userRole: session.userRole,
      outcome: bundle.outcome,
      decision: bundle.decision,
      reason: bundle.reason,
      memoryCount: bundle.memoryCount,
      responseChars: bundle.response.length,
      errorClass: null,
      auditVerdict: bundle.auditVerdict,
      memoriesStored: bundle.memoriesStored,
      factsExtracted: bundle.factsExtracted,
    });

    log('info', 'web.chat.responded', {
      role: session.userRole,
      message_bytes: byteLength,
      outcome: bundle.outcome,
      decision: bundle.decision,
      reason: bundle.reason,
      memory_count: bundle.memoryCount,
      response_chars: bundle.response.length,
      audit_verdict: bundle.auditVerdict,
      memories_stored: bundle.memoriesStored,
      facts_extracted: bundle.factsExtracted,
    });

    return jsonResponse(res, 200, {
      response: bundle.response,
      memoryCount: bundle.memoryCount,
      outcome: bundle.outcome,
      decision: bundle.decision,
      intentType: bundle.intentType,
      reason: bundle.reason,
      policyRef: bundle.policyRef,
      executed: bundle.executed,
      auditVerdict: bundle.auditVerdict,
      auditDetails: bundle.auditDetails,
      auditReason: bundle.auditReason,
      memoriesStored: bundle.memoriesStored,
      factsExtracted: bundle.factsExtracted,
      visibilityLevel: bundle.visibilityLevel,
    });
  }

  function handleAdminRecent(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    if (session.userRole !== 'admin') {
      return jsonResponse(res, 403, { error: 'admin role required' });
    }
    return jsonResponse(res, 200, {
      capacity: recent.capacity,
      size: recent.size(),
      entries: recent.list(),
    });
  }

  async function handleAdminMemories(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    if (session.userRole !== 'admin') {
      return jsonResponse(res, 403, { error: 'admin role required' });
    }
    let memories;
    try {
      memories = await wiring.listMemoriesForInspector({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        limit: 100,
      });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.admin.memories_failed', { error_class: errorClass });
      return jsonResponse(res, 502, { error: 'failed to load memories', errorClass });
    }
    return jsonResponse(res, 200, {
      count: memories.length,
      memories,
    });
  }

  async function handleAdminGovernanceEvents(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    if (session.userRole !== 'admin') {
      return jsonResponse(res, 403, { error: 'admin role required' });
    }
    let events;
    try {
      events = await wiring.listGovernanceEvents({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        limit: 50,
      });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.admin.governance_events_failed', { error_class: errorClass });
      return jsonResponse(res, 502, { error: 'failed to load events', errorClass });
    }
    return jsonResponse(res, 200, {
      count: events.length,
      events,
    });
  }

  // ---------- Debug: per-session identity inspection ----------
  //
  // GET /api/_debug/identity returns the current session's identity
  // resolution + a content-free memory snapshot. Off unless
  // LYLO_DEBUG_IDENTITY=true. Designed for the cross-account leak
  // workflow:
  //   1. Sign in as account A in browser A. GET /api/_debug/identity.
  //   2. Sign in as account B in browser B. GET /api/_debug/identity.
  //   3. Compare:
  //      - sessionUserId must differ.
  //      - sessionDisplayName / sessionCompanionLabel may or may not
  //        differ — operator inspects.
  //      - visibleMemories[].owningUserIdPrefix should equal
  //        sessionUserId's prefix for every row that the user owns;
  //        rows with a DIFFERENT owningUserIdPrefix are family_shared
  //        memories the session has been granted access to (via
  //        circle_contacts). If account B sees rows owned by
  //        account A WITHOUT a circle membership, that's an RLS bug.
  // No memory content is returned. Only ids (8-char prefixes),
  // owning_user_id prefixes, visibility, authority, status, active.
  async function handleDebugIdentity(req, res) {
    if (!DEBUG_IDENTITY) {
      return jsonResponse(res, 404, { error: 'not found' });
    }
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    let snapshot;
    try {
      snapshot = await wiring.getDebugSessionSnapshot({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        limit: 20,
      });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'identity_debug.snapshot_failed', {
        pilot_instance_id: pilotInstanceId,
        session_user_id: session.userId,
        error_class: errorClass,
      });
      return jsonResponse(res, 502, { error: 'debug snapshot failed', errorClass });
    }
    log('info', 'identity_debug.snapshot', {
      pilot_instance_id: pilotInstanceId,
      session_user_id: session.userId,
      session_user_role: session.userRole,
      session_display_name_length: typeof session.displayName === 'string' ? session.displayName.length : 0,
      session_companion_label_value: session.companionLabel,
      session_issued_at: session.issuedAt,
      bound_user_id: snapshot.boundUserId,
      bound_user_role: snapshot.boundUserRole,
      binding_matches: snapshot.bindingMatches,
      memory_count: snapshot.memoryCount,
      distinct_owner_count: snapshot.distinctOwnerCount,
      owner_user_id_prefixes: snapshot.ownerUserIdPrefixes,
      any_mentions_favorite_food: snapshot.anyMentionsFavoriteFood,
      any_mentions_sushi: snapshot.anyMentionsSushi,
    });
    return jsonResponse(res, 200, {
      pilotInstanceId,
      sessionUserId: session.userId,
      sessionUserRole: session.userRole,
      sessionDisplayNameLength: typeof session.displayName === 'string' ? session.displayName.length : 0,
      sessionCompanionLabel: session.companionLabel,
      sessionIssuedAt: session.issuedAt,
      // Bound session vars — proves what the database actually
      // received via set_config(). If bindingMatches is false, the
      // whole RLS posture is suspect.
      boundPilotInstanceId: snapshot.boundPilotInstanceId,
      boundUserId: snapshot.boundUserId,
      boundUserRole: snapshot.boundUserRole,
      bindingMatches: snapshot.bindingMatches,
      memoryCount: snapshot.memoryCount,
      distinctOwnerCount: snapshot.distinctOwnerCount,
      // The smoking-gun flag: does THIS session's visible memory
      // set contain a sushi mention? Yes/no. Compare across two
      // browser sessions; if one is true and the other is false
      // with distinct boundUserIds, each user has their own copy
      // (hypothesis H2). If both are true with the SAME bound
      // user id, identity collapsed.
      anyMentionsFavoriteFood: snapshot.anyMentionsFavoriteFood,
      anyMentionsSushi: snapshot.anyMentionsSushi,
      visibleMemories: snapshot.visibleMemories,
    });
  }

  // ---------- Phase 3: circle contacts ----------

  function userClassToStatus(uc) {
    if (uc === 'bad_request') return 400;
    if (uc === 'not_found') return 404;
    if (uc === 'unavailable') return 503;
    return 502;
  }

  async function handleCircleList(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    let contacts;
    try {
      contacts = await wiring.listCircleContacts({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
      });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.circle.list_failed', { error_class: errorClass });
      return jsonResponse(res, userClassToStatus(err.userClass), {
        error: err.userClass === 'unavailable' ? 'circle service unavailable' : 'failed to list contacts',
        errorClass,
      });
    }
    return jsonResponse(res, 200, { count: contacts.length, contacts });
  }

  async function handleCircleAdd(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    const body = await parseJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const rawLevels = Array.isArray(body.visibilityLevels) ? body.visibilityLevels : [];
    // Sanitize at the HTTP edge — only forward known-good tier
    // strings. The repository will reject anything else.
    const visibilityLevels = rawLevels.filter((v) => v === 'family_shared');
    if (email === '') {
      return jsonResponse(res, 400, { error: 'email is required' });
    }
    try {
      const created = await wiring.addCircleContact({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        email,
        visibilityLevels,
      });
      return jsonResponse(res, 200, { ok: true, contact: created });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.circle.add_failed', { error_class: errorClass });
      if (err.userClass === 'not_found') {
        return jsonResponse(res, 404, { error: 'no user with that email in your pilot' });
      }
      if (err.userClass === 'bad_request') {
        return jsonResponse(res, 400, { error: err.message || 'bad request' });
      }
      if (err.userClass === 'unavailable') {
        return jsonResponse(res, 503, { error: 'circle service unavailable' });
      }
      return jsonResponse(res, 502, { error: 'failed to add contact', errorClass });
    }
  }

  async function handleCircleSetScope(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — sign in first' });
    }
    const body = await parseJsonBody(req);
    const id = typeof body.id === 'string' ? body.id : '';
    const rawLevels = Array.isArray(body.visibilityLevels) ? body.visibilityLevels : [];
    const visibilityLevels = rawLevels.filter((v) => v === 'family_shared');
    if (id === '') {
      return jsonResponse(res, 400, { error: 'id is required' });
    }
    try {
      const updated = await wiring.setCircleContactPermissions({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        id,
        visibilityLevels,
      });
      return jsonResponse(res, 200, { ok: true, contact: updated });
    } catch (err) {
      const errorClass = describeErrClass(err);
      log('warn', 'web.circle.set_scope_failed', { error_class: errorClass });
      if (err.userClass === 'bad_request') {
        return jsonResponse(res, 400, { error: err.message || 'bad request' });
      }
      if (err.userClass === 'unavailable') {
        return jsonResponse(res, 503, { error: 'circle service unavailable' });
      }
      return jsonResponse(res, 502, { error: 'failed to update contact', errorClass });
    }
  }

  function handleLogout(req, res) {
    const setCookie = buildClearCookie(COOKIE_NAME);
    return jsonResponse(res, 200, { ok: true }, { 'Set-Cookie': setCookie });
  }

  function handleStatic(rel, contentType, res) {
    try {
      const bytes = loadStatic(repoRoot, rel);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      res.end(bytes);
    } catch (err) {
      log('warn', 'web.static.error', { rel, error_class: describeErrClass(err) });
      textResponse(res, 500, 'failed to load static asset');
    }
  }

  async function route(req, res) {
    let pathname = '/';
    let method = req.method || 'GET';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }

    if (method === 'GET' && pathname === '/healthz') {
      return jsonResponse(res, 200, { status: 'live' });
    }

    if (method === 'GET') {
      const stat = STATIC_FILES[pathname];
      if (stat) return handleStatic(stat.rel, stat.type, res);
    }

    if (method === 'POST' && pathname === '/api/signup') return handleSignup(req, res);
    if (method === 'POST' && pathname === '/api/login')  return handleLogin(req, res);
    if (method === 'POST' && pathname === '/api/chat')   return handleChat(req, res);
    if (method === 'GET'  && pathname === '/api/admin/recent') return handleAdminRecent(req, res);
    if (method === 'GET'  && pathname === '/api/admin/memories') return handleAdminMemories(req, res);
    if (method === 'GET'  && pathname === '/api/admin/governance-events') return handleAdminGovernanceEvents(req, res);
    if (method === 'GET'  && pathname === '/api/_debug/identity') return handleDebugIdentity(req, res);
    if (method === 'GET'  && pathname === '/api/circle/contacts') return handleCircleList(req, res);
    if (method === 'POST' && pathname === '/api/circle/contacts') return handleCircleAdd(req, res);
    if (method === 'POST' && pathname === '/api/circle/contacts/scope') return handleCircleSetScope(req, res);
    if (method === 'POST' && pathname === '/api/logout') return handleLogout(req, res);

    return jsonResponse(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const userClass = err && err.userClass;
      const errorClass = describeErrClass(err);
      log('warn', 'web.request.error', { error_class: errorClass });
      if (userClass === 'payload_too_large') {
        return jsonResponse(res, 413, { error: 'payload too large' });
      }
      if (userClass === 'bad_request') {
        return jsonResponse(res, 400, { error: err.message || 'bad request' });
      }
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'internal error', errorClass });
      } else {
        res.end();
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

module.exports = { createTestDoorServer };
