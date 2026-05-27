-- Grant lylo_app the narrowly-scoped INSERT + UPDATE it needs to drive
-- circle-contacts management from the test-door web layer (Phase 3).
--
-- Why this exists:
--   - db/migrations/002 created circle_contacts.
--   - db/migrations/007 enabled RLS, granted SELECT to lylo_app, and
--     installed three FOR SELECT policies (senior, contact, admin).
--     It did NOT grant INSERT or UPDATE, and did NOT install
--     FOR INSERT or FOR UPDATE policies — making the table
--     read-only from lylo_app.
--   - src/circle/repository.js#insertCircleContact and
--     src/circle/repository.js#setCircleContactScope need to write
--     this table from the lylo_app role to wire the existing
--     substrate into the app surface.
--   - Without these grants + policies, every Phase 3 write would
--     fail with permission denied before RLS even ran.
--
-- Defense in depth (unchanged):
--   - Caller is always the senior_user_id; INSERT WITH CHECK and
--     UPDATE USING both pin pilot_instance_id and senior_user_id
--     to the binding session vars. A contact cannot rewrite a
--     senior's grant row — the predicate fails.
--   - lylo_app has NO BYPASSRLS; the policies remain authoritative.
--   - The UPDATE grant is column-scoped to permission_scope. The
--     other columns (id, pilot_instance_id, senior_user_id,
--     contact_user_id, created_at) are not mutable from lylo_app
--     at all — Postgres rejects UPDATE on a column not in the
--     column-grant list with a permission-denied error.
--   - The circle boundary CI guard
--     (scripts/ci/check-circle-boundary.js) restricts UPDATE
--     statements in src/circle/ to repository.js, to
--     circle_contacts, and to the permission_scope column only.
--
-- This migration MUST be applied to every existing deployment for
-- Phase 3 circle management to function.

GRANT INSERT ON circle_contacts TO lylo_app;
GRANT UPDATE (permission_scope) ON circle_contacts TO lylo_app;

-- INSERT policy: senior can add a circle row for themselves in
-- their own pilot. The WITH CHECK is the WHERE-clause of "is this
-- the caller's pilot + the caller as senior". USING is N/A for
-- pure-INSERT policies.
DROP POLICY IF EXISTS circle_contacts_senior_insert ON circle_contacts;
CREATE POLICY circle_contacts_senior_insert ON circle_contacts FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND senior_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- UPDATE policy: senior can modify rows they own (where they are
-- the senior). USING narrows which rows the UPDATE can see. WITH
-- CHECK pins the post-state to the same predicate so a senior
-- can't reassign senior_user_id away from themselves — even though
-- the column-scoped grant already prevents updating senior_user_id
-- as a column, this is belt-and-suspenders against future grant
-- changes.
DROP POLICY IF EXISTS circle_contacts_senior_update ON circle_contacts;
CREATE POLICY circle_contacts_senior_update ON circle_contacts FOR UPDATE
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND senior_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND senior_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Rollback (revoke + drop policies; circle management will silently break):
-- DROP POLICY IF EXISTS circle_contacts_senior_update ON circle_contacts;
-- DROP POLICY IF EXISTS circle_contacts_senior_insert ON circle_contacts;
-- REVOKE UPDATE (permission_scope) ON circle_contacts FROM lylo_app;
-- REVOKE INSERT ON circle_contacts FROM lylo_app;
