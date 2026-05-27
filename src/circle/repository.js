'use strict';
/*
 * Circle-contacts repository — Phase 3 of the substrate wiring.
 *
 * Operations:
 *   - lookupUserByEmail(client, sessionCtx, email):
 *       Resolves an email to a public.users.id within the caller's
 *       pilot. Phase 2 (identity.js) sets users.username to the
 *       email at signup, so this is a LOWER(username) lookup. The
 *       lookup is pilot-scoped — a contact must be in the same
 *       pilot to be addable.
 *
 *   - insertCircleContact(client, sessionCtx, input):
 *       Adds a row to circle_contacts where the calling user is
 *       the senior. visibilityLevels must be a subset of the
 *       caller-facing tiers; password_locked is forbidden here
 *       because the vault unlock flow is out of scope.
 *
 *   - listCircleContactsForSenior(client, sessionCtx):
 *       Returns the calling user's circle (rows where they are
 *       the senior).
 *
 *   - setCircleContactScope(client, sessionCtx, id, visibilityLevels):
 *       Updates permission_scope on an existing row owned by the
 *       caller. An empty array is the soft-delete path (default-
 *       deny restored).
 *
 * Default-deny is preserved by the substrate (CHECK on the table's
 * permission_scope JSONB shape and the RLS policies that join on
 * 'family_shared' membership). This repository never inserts a row
 * with a tier the caller did not explicitly request.
 *
 * Hard rules:
 *   - Visibility tiers accepted here: 'family_shared'. 'private'
 *     does not need a circle row (the owner already sees it).
 *     'password_locked' is forbidden — it requires vault session
 *     state, not just permission_scope membership.
 *   - No DELETE in this file — soft-delete is via UPDATE to []
 *     permission_scope. The boundary checker enforces this.
 *   - The caller is always the senior_user_id. A contact cannot
 *     add themselves; the senior must initiate.
 *   - Cross-pilot is impossible: the lookup is pilot-scoped, the
 *     INSERT uses sessionCtx.pilotInstanceId, and RLS narrows
 *     reads to the caller's pilot.
 */

const VALID_VISIBILITY_TIERS = new Set(['family_shared']);

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function validateVisibilityLevels(input) {
  if (!Array.isArray(input)) {
    throw new Error('visibilityLevels must be an array');
  }
  const seen = new Set();
  for (const v of input) {
    if (typeof v !== 'string' || !VALID_VISIBILITY_TIERS.has(v)) {
      throw new Error(
        `visibilityLevels: "${v}" not permitted (allowed: ${Array.from(VALID_VISIBILITY_TIERS).join(', ')})`
      );
    }
    seen.add(v);
  }
  return Array.from(seen).sort();
}

async function lookupUserByEmail(client, sessionCtx, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error('lookupUserByEmail: email is required');
  }
  // identity.js sets username to the normalized email at provisioning.
  // Pilot-scoped: a contact in a different pilot is invisible.
  const result = await client.query(
    'SELECT id, username, role FROM users '
      + 'WHERE pilot_instance_id = $1 AND LOWER(username) = $2 LIMIT 1',
    [sessionCtx.pilotInstanceId, normalized]
  );
  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    role: result.rows[0].role,
  };
}

async function insertCircleContact(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('insertCircleContact: input is required');
  }
  const { contactUserId, visibilityLevels } = input;
  if (typeof contactUserId !== 'string' || contactUserId.length === 0) {
    throw new Error('insertCircleContact: contactUserId is required');
  }
  if (contactUserId === sessionCtx.userId) {
    throw new Error('insertCircleContact: cannot add yourself as a circle contact');
  }
  const levels = validateVisibilityLevels(visibilityLevels);
  const scopeJson = JSON.stringify({ visibility_levels: levels });
  const result = await client.query(
    'INSERT INTO circle_contacts '
      + '(pilot_instance_id, senior_user_id, contact_user_id, permission_scope) '
      + 'VALUES ($1, $2, $3, $4::jsonb) '
      + 'RETURNING id, created_at',
    [sessionCtx.pilotInstanceId, sessionCtx.userId, contactUserId, scopeJson]
  );
  return {
    id: result.rows[0].id,
    contactUserId,
    visibilityLevels: levels,
    createdAt: result.rows[0].created_at,
  };
}

async function listCircleContactsForSenior(client, sessionCtx) {
  // RLS narrows to the caller's pilot. The WHERE here narrows to
  // rows where the caller is the senior (so a family contact who
  // only sees their own incoming rows doesn't show up).
  const result = await client.query(
    'SELECT cc.id, cc.contact_user_id, u.username AS contact_username, '
      + 'u.role AS contact_role, cc.permission_scope, cc.created_at '
      + 'FROM circle_contacts cc '
      + 'JOIN users u ON u.id = cc.contact_user_id '
      + 'WHERE cc.senior_user_id = $1 '
      + 'ORDER BY cc.created_at DESC',
    [sessionCtx.userId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    contactUserId: r.contact_user_id,
    contactUsername: r.contact_username,
    contactRole: r.contact_role,
    visibilityLevels: (r.permission_scope && Array.isArray(r.permission_scope.visibility_levels))
      ? r.permission_scope.visibility_levels.slice().sort()
      : [],
    createdAt: r.created_at,
  }));
}

async function setCircleContactScope(client, sessionCtx, id, visibilityLevels) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('setCircleContactScope: id is required');
  }
  const levels = validateVisibilityLevels(visibilityLevels);
  const scopeJson = JSON.stringify({ visibility_levels: levels });
  // pilot + senior gate prevents a contact from rewriting their
  // own scope row. The senior is always the row's owner.
  const result = await client.query(
    'UPDATE circle_contacts '
      + 'SET permission_scope = $4::jsonb '
      + 'WHERE id = $1 AND pilot_instance_id = $2 AND senior_user_id = $3 '
      + 'RETURNING id',
    [id, sessionCtx.pilotInstanceId, sessionCtx.userId, scopeJson]
  );
  if (result.rows.length === 0) {
    throw new Error('setCircleContactScope: not found or not owned by caller');
  }
  return { id, visibilityLevels: levels };
}

module.exports = {
  lookupUserByEmail,
  insertCircleContact,
  listCircleContactsForSenior,
  setCircleContactScope,
  VALID_VISIBILITY_TIERS,
};
