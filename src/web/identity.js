'use strict';
/*
 * Identity resolver — maps a verified Supabase auth_user_id to the
 * canonical public.users row that the substrate uses.
 *
 * On first login for an auth identity, JIT-provisions a public.users
 * row keyed on auth_user_id. The role is 'admin' if the email is in
 * the bootstrap admin list, 'senior' otherwise. The username column
 * is set to the email (lowercased, trimmed) — purely a human-
 * readable handle, never used to scope queries.
 *
 * Connection: uses lylo_setup_login via LYLO_SETUP_DATABASE_URL. This
 * is the SAME role the seed script uses (scripts/test-door/
 * seed-test-pilot.js) and the same role the GM-12 provisioning
 * pipeline uses. lylo_setup has BYPASSRLS via the GRANT chain in
 * migration 007; that is required for INSERT into users because the
 * inserting connection has no session vars set yet (you can't bind
 * app.user_id to a row that doesn't exist).
 *
 * Boundary posture:
 *   - src/web/ is NOT scanned by any module-boundary CI guard, so
 *     this file is allowed to import pg via src/db/client.js.
 *   - This module DOES NOT import the memory layer, DOES NOT touch
 *     memory_store, DOES NOT add a new audit event, DOES NOT add
 *     a new EVENT_TYPES value. It only operates on users.
 *
 * Failure posture:
 *   - resolveOrProvision rejects with an Error if the connection or
 *     the INSERT fails. Server's handleLogin / handleSignup catches
 *     and returns a 502 to the browser — failing safe, not silent.
 */

const { createPool } = require('../db/client');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

function bootstrapAdminEmailsFromEnv(rawList) {
  if (typeof rawList !== 'string') return new Set();
  const out = new Set();
  for (const part of rawList.split(',')) {
    const e = normalizeEmail(part);
    if (e) out.add(e);
  }
  return out;
}

/*
 * createIdentityResolver
 *   options:
 *     setupDatabaseUrl    (required) LYLO_SETUP_DATABASE_URL — pg URL
 *                                    for lylo_setup_login.
 *     pilotInstanceId     (required) the single test-door pilot id.
 *     bootstrapAdminEmails Set<string> of emails that auto-receive
 *                                    role='admin' on first signup.
 *                                    Default: empty.
 *     log                 (optional) (level, event, fields) callback.
 *
 *   Returns { resolveOrProvision, close }.
 *
 *   resolveOrProvision({ authUserId, email }) →
 *     { userId, userRole, email, displayName, isNewUser }
 *
 *   `authUserId` and `email` must already have been verified by the
 *   caller (jwt-verify confirmed the JWT signature and `sub` is the
 *   authUserId, supabase-auth surfaced the verified email).
 */
function createIdentityResolver(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createIdentityResolver: options required');
  }
  const { pilotInstanceId } = options;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('createIdentityResolver: pilotInstanceId must be a UUID');
  }
  const bootstrapAdmins = options.bootstrapAdminEmails instanceof Set
    ? options.bootstrapAdminEmails
    : new Set();
  const log = typeof options.log === 'function' ? options.log : () => {};

  // Pool resolution: either inject a pool directly (tests) or pass
  // a setupDatabaseUrl and we'll construct one via src/db/client.
  // Exactly one of the two must be provided.
  let pool;
  let ownsPool = false;
  if (options.pool) {
    pool = options.pool;
  } else if (typeof options.setupDatabaseUrl === 'string' && options.setupDatabaseUrl.length > 0) {
    pool = createPool(options.setupDatabaseUrl, {
      log: (level, event, fields) => log(level, event, fields),
    });
    ownsPool = true;
  } else {
    throw new Error('createIdentityResolver: setupDatabaseUrl or pool required');
  }

  async function resolveOrProvision(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('resolveOrProvision: input required');
    }
    const { authUserId, email: rawEmail } = input;
    if (typeof authUserId !== 'string' || !UUID_RE.test(authUserId)) {
      throw new Error('resolveOrProvision: authUserId must be a UUID');
    }
    const email = normalizeEmail(rawEmail);
    if (!email) {
      throw new Error('resolveOrProvision: email is required');
    }

    // Look up by auth_user_id (the partial index from migration 017
    // makes this O(log n) on a single column).
    const existing = await pool.query(
      'SELECT id, role, username FROM users WHERE auth_user_id = $1 AND pilot_instance_id = $2 LIMIT 1',
      [authUserId, pilotInstanceId]
    );
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      log('info', 'web.identity.resolved_existing', {
        pilot_instance_id: pilotInstanceId,
        user_id: row.id,
        role: row.role,
      });
      return {
        userId: row.id,
        userRole: row.role,
        email,
        displayName: row.username,
        isNewUser: false,
      };
    }

    // First login for this auth identity — provision a new row. Role
    // is admin only if the email is on the bootstrap list AND no
    // pre-existing public.users row has this email already (we
    // intentionally do NOT promote by email collision; the bootstrap
    // is a one-way upgrade at provisioning time).
    const role = bootstrapAdmins.has(email) ? 'admin' : 'senior';

    let inserted;
    try {
      inserted = await pool.query(
        'INSERT INTO users (pilot_instance_id, username, role, auth_user_id) '
          + 'VALUES ($1, $2, $3, $4) RETURNING id',
        [pilotInstanceId, email, role, authUserId]
      );
    } catch (err) {
      // Most likely cause: (pilot_instance_id, username) UNIQUE
      // collision on a legacy row that already has this email. Try
      // to ATTACH the auth identity to that row instead of failing.
      // This is the migration path for an existing user (e.g.
      // test_door_senior whose username happens to be the same email
      // the operator now signs up with). Strictly opt-in: only fires
      // when the row has auth_user_id IS NULL.
      if (err && err.code === '23505') {
        const attached = await pool.query(
          'UPDATE users SET auth_user_id = $1 '
            + 'WHERE pilot_instance_id = $2 AND username = $3 AND auth_user_id IS NULL '
            + 'RETURNING id, role',
          [authUserId, pilotInstanceId, email]
        );
        if (attached.rowCount > 0) {
          log('info', 'web.identity.attached_legacy', {
            pilot_instance_id: pilotInstanceId,
            user_id: attached.rows[0].id,
            role: attached.rows[0].role,
          });
          return {
            userId: attached.rows[0].id,
            userRole: attached.rows[0].role,
            email,
            displayName: email,
            isNewUser: false,
          };
        }
      }
      // Either it's not a collision we can heal, or the legacy row
      // already had an auth_user_id (different identity, same email
      // — that's an impersonation attempt or a genuine conflict).
      // Fail closed.
      throw err;
    }

    log('info', 'web.identity.provisioned', {
      pilot_instance_id: pilotInstanceId,
      user_id: inserted.rows[0].id,
      role,
    });
    return {
      userId: inserted.rows[0].id,
      userRole: role,
      email,
      displayName: email,
      isNewUser: true,
    };
  }

  async function close() {
    if (ownsPool) await pool.end();
  }

  return Object.freeze({ resolveOrProvision, close });
}

module.exports = {
  createIdentityResolver,
  bootstrapAdminEmailsFromEnv,
  normalizeEmail,
};
