-- Path 2 auth integration — links public.users to Supabase Auth's auth.users.
--
-- WHY THIS COLUMN EXISTS
-- The pre-auth test door mapped every "regular" login to one hardcoded
-- senior UUID (LYLO_TEST_SENIOR_USER_ID env var). That collapsed all
-- distinct humans into a single substrate identity — the cross-user
-- isolation guarantee the RLS layer enforces was structurally
-- bypassed at the identity layer. See docs/governance/fail-open-policy.md
-- and the operator's live test (Chris/Jill/Aubrey/pineapple) for the
-- failure mode this column closes.
--
-- WHAT THIS COLUMN DOES
-- Stores the Supabase Auth user id (the `sub` claim from a verified
-- access_token JWT) on the corresponding public.users row. The web
-- layer's signup flow inserts a public.users row keyed on the
-- authenticated identity from Supabase; subsequent logins look up
-- the row by auth_user_id, set session.userId = users.id, and the
-- existing RLS contract (memory_store_owner, etc.) narrows by that
-- distinct id.
--
-- WHAT THIS COLUMN DOES NOT DO
-- It does NOT touch RLS policies, does NOT touch memory_store, does
-- NOT add a new EVENT_TYPES value, does NOT add a new substrate
-- table, does NOT add a new actor, does NOT add a new ctx operation.
-- It is identity-layer only.
--
-- POSTURE
-- Nullable. Existing legacy rows (test_door_senior, test_door_admin
-- from scripts/test-door/seed-test-pilot.js) keep auth_user_id =
-- NULL — they are no longer reachable through the new web auth flow
-- but the substrate accepts them as historic identity records.
-- UNIQUE constraint applies only to non-NULL values per Postgres
-- default semantics, so the legacy NULL rows do not collide with
-- each other or with future auth-provisioned rows.
--
-- GRANTS
-- No new grants required. lylo_setup_login (BYPASSRLS via the
-- IN ROLE lylo_setup grant in migration 007) already has INSERT
-- and SELECT on users; that is the role the new src/web/identity.js
-- uses to JIT-provision a row on first login. lylo_app_login keeps
-- its existing SELECT (column-level grants are not used; SELECT is
-- table-level).

ALTER TABLE users
  ADD COLUMN auth_user_id UUID UNIQUE;

-- Partial index for the login-time lookup `WHERE auth_user_id = $1`.
-- Partial because legacy rows are NULL and never queried by this
-- column.
CREATE INDEX users_auth_user_id_idx
  ON users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Rollback (un-link auth + drop column; new auth provisioning will
-- silently fail to record the auth identity until column is restored):
-- DROP INDEX IF EXISTS users_auth_user_id_idx;
-- ALTER TABLE users DROP COLUMN IF EXISTS auth_user_id;
