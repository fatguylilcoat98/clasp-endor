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
 *   POST /api/setup         → seal session cookie for chosen role
 *   POST /api/chat          → classify + actor.execute (real model)
 *   GET  /api/admin/recent  → ring buffer (admin only)
 *   POST /api/logout        → clear session cookie
 *
 * Hard rules:
 *   - Real user messages are never logged. Only metadata.
 *   - The model response is never logged. Only the character count.
 *   - The session cookie never carries persona or API key.
 *   - Admin-only endpoints fail with 403 for non-admin sessions.
 *   - The mold's substrate is not touched: no DB writes outside the
 *     governed memory chain that the actor already drives.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  createSessionCodec,
  parseCookieHeader,
  buildSetCookie,
  buildClearCookie,
  COOKIE_NAME,
} = require('./session');
const { createRecentBuffer } = require('./recent');
const { describeErrClass } = require('./wiring');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 8192;
const MAX_DISPLAY_NAME_LEN = 64;
const MAX_COMPANION_LABEL_LEN = 64;
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

function pickUserIdForRole(role, identities) {
  if (role === 'admin') return identities.adminUserId;
  if (role === 'regular') return identities.seniorUserId;
  return null;
}

function loadStatic(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  return fs.readFileSync(abs);
}

/*
 * createTestDoorServer
 *
 * Options:
 *   repoRoot   — absolute path to the clasp-endor repo root. Used to
 *                resolve public/ static assets.
 *   identities — { pilotInstanceId, seniorUserId, adminUserId }, all
 *                UUIDs. Sourced from env in boot-web; tests pass
 *                literals.
 *   sessionCodec — session.createSessionCodec instance.
 *   wiring     — wiring.createTestDoorWiring instance.
 *   recent     — recent.createRecentBuffer instance.
 *   log        — (level, event, fields) callback.
 *   secureCookie — boolean. When true, the Set-Cookie carries Secure.
 *                  Tests pass false.
 */
function createTestDoorServer(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createTestDoorServer: options object is required');
  }
  const { repoRoot, identities, sessionCodec, wiring, recent, log } = options;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('createTestDoorServer: repoRoot is required');
  }
  if (!identities || typeof identities !== 'object') {
    throw new Error('createTestDoorServer: identities object is required');
  }
  const { pilotInstanceId, seniorUserId, adminUserId } = identities;
  if (!UUID_RE.test(pilotInstanceId) || !UUID_RE.test(seniorUserId) || !UUID_RE.test(adminUserId)) {
    throw new Error('createTestDoorServer: pilotInstanceId, seniorUserId, adminUserId must all be UUIDs');
  }
  if (!sessionCodec || typeof sessionCodec.seal !== 'function') {
    throw new Error('createTestDoorServer: sessionCodec is required');
  }
  if (!wiring || typeof wiring.handleChat !== 'function') {
    throw new Error('createTestDoorServer: wiring with handleChat is required');
  }
  if (!recent || typeof recent.record !== 'function') {
    throw new Error('createTestDoorServer: recent buffer is required');
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

  async function handleSetup(req, res) {
    const body = await parseJsonBody(req);
    const displayName = normalizeDisplayName(body.name);
    if (!displayName) {
      return jsonResponse(res, 400, { error: 'name is required' });
    }
    const role = body.role;
    if (role !== 'regular' && role !== 'admin') {
      return jsonResponse(res, 400, { error: 'role must be "regular" or "admin"' });
    }
    const companionLabel = normalizeCompanionLabel(body.companionName);
    const userId = pickUserIdForRole(role, { seniorUserId, adminUserId });
    const userRole = role === 'admin' ? 'admin' : 'senior';

    const payload = {
      userId,
      userRole,
      displayName,
      companionLabel,
      issuedAt: Date.now(),
    };
    const cookieValue = sessionCodec.seal(payload);
    const setCookie = buildSetCookie(COOKIE_NAME, cookieValue, {
      maxAgeSeconds: 12 * 60 * 60,
      secure: secureCookie,
    });

    log('info', 'web.setup', {
      role: userRole,
      display_name_chars: displayName.length,
      companion_label_chars: companionLabel ? companionLabel.length : 0,
    });

    return jsonResponse(
      res,
      200,
      {
        displayName,
        userRole,
        companionLabel,
        isAdmin: userRole === 'admin',
      },
      { 'Set-Cookie': setCookie }
    );
  }

  async function handleChat(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — complete setup first' });
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

    let bundle;
    try {
      // Build companion configuration from session
      const companionConfig = {
        name: session.companionLabel || 'Assistant',
        persona: 'You are a helpful and friendly AI companion.'
      };

      bundle = await wiring.handleChat({
        pilotInstanceId,
        userId: session.userId,
        userRole: session.userRole,
        userMessage,
        companionConfig,
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
      // Brain-runtime audit + memory-writer fields. The wiring builds
      // these; the UI's gov panel reads them. Omitting them here
      // silently hides the audit verdict from the operator panel.
      auditVerdict: bundle.auditVerdict,
      auditDetails: bundle.auditDetails,
      auditReason: bundle.auditReason,
      memoriesStored: bundle.memoriesStored,
      factsExtracted: bundle.factsExtracted,
    });
  }

  function handleAdminRecent(req, res) {
    const session = getSession(req);
    if (!session) {
      return jsonResponse(res, 401, { error: 'no session — complete setup first' });
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

    if (method === 'POST' && pathname === '/api/setup') return handleSetup(req, res);
    if (method === 'POST' && pathname === '/api/chat') return handleChat(req, res);
    if (method === 'GET' && pathname === '/api/admin/recent') return handleAdminRecent(req, res);
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
