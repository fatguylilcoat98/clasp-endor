-- Plan: GM-15. Apply the RLS / privacy policies validated in GM-14
-- against the synthetic schema (tests/rls-contract/policies.sql) to
-- the real db/migrations/ schema.
--
-- Scope: migration only. This file:
--   - creates the four Lylo DB roles (lylo_runtime, lylo_app,
--     lylo_setup, lylo_admin) idempotently;
--   - grants schema USAGE and per-table SELECT/INSERT/UPDATE
--     privileges per the rls-privacy-contract DB-role model;
--   - enables row-level security on the ten client-scoped tables;
--   - applies the validated visibility / write / default-deny
--     policies.
--
-- What this migration does NOT do (deferred to GM-16):
--   - change how the runtime connects to the database. The runtime
--     keeps booting as the operator-provided DATABASE_URL user
--     (typically the bootstrap superuser, which BYPASSRLS); RLS is
--     therefore dormant in production after this migration applies.
--   - change how scripts/setup/provision-instance.js connects. It
--     also keeps using the bootstrap user.
--   - parse LYLO_RUNTIME_DATABASE_URL / LYLO_SETUP_DATABASE_URL or
--     introduce SET LOCAL app.* session-variable wiring. Those are
--     GM-16's scope.
--
-- The policies below mirror tests/rls-contract/policies.sql
-- byte-for-byte semantically (NULLIF guard included). The single
-- divergence is the pilot_instances_runtime_bootstrap policy: it
-- gives lylo_runtime unconditional SELECT on pilot_instances so a
-- future env-first GM-16 boot can resolve its pilot id safely under
-- single-tenant. Belt-and-suspenders: under the env-first model the
-- runtime sets app.pilot_instance_id before any query, so the
-- tenant_scope policy would already permit the read; the bootstrap
-- policy fails closed only if env is misconfigured.
--
-- Idempotency: roles are created in DO blocks that swallow
-- duplicate_object; ALTER ROLE / GRANT / ALTER TABLE ENABLE are
-- state-setters and are safe to re-run; every policy is preceded by
-- DROP POLICY IF EXISTS so re-applying the migration is a no-op.

-- ---------------------------------------------------------------------
-- DB roles (NOLOGIN). The connecting application gains identity via a
-- separate LOGIN role with membership in one of these, or via SET ROLE
-- — both wired in GM-16.
-- ---------------------------------------------------------------------

DO $$ BEGIN
  CREATE ROLE lylo_runtime NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE lylo_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE lylo_setup NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE lylo_setup BYPASSRLS;

DO $$ BEGIN
  CREATE ROLE lylo_admin NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Schema usage. Postgres 15+ tightened the public schema's default
-- privileges; without USAGE on the schema, a role sees no relations
-- in it. Every Lylo role needs USAGE so the table-level GRANTs below
-- can take effect.
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO lylo_runtime, lylo_app, lylo_setup, lylo_admin;

-- ---------------------------------------------------------------------
-- Table-level grants. RLS narrows ROWS within granted tables; a role
-- without GRANT on a table cannot access it at all.
-- ---------------------------------------------------------------------

GRANT SELECT ON pilot_instances, companion_profile, supported_person_profile, setup_state
  TO lylo_runtime;

GRANT SELECT ON pilot_instances, users, companion_profile, supported_person_profile,
                circle_contacts, memory_vaults, memory_vault_sessions, memory_store,
                governance_audit_log
  TO lylo_app;
GRANT INSERT ON memory_store, governance_audit_log, memory_vault_sessions TO lylo_app;
GRANT UPDATE (revoked_at) ON memory_vault_sessions TO lylo_app;

GRANT INSERT, SELECT ON pilot_instances, users, companion_profile,
                        supported_person_profile, setup_state
  TO lylo_setup;

GRANT SELECT ON pilot_instances, users, companion_profile, supported_person_profile,
                circle_contacts, memory_vaults, memory_vault_sessions,
                governance_audit_log, setup_state
  TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS on every client-scoped table. Without an explicit policy,
-- a granted role sees zero rows (default-deny).
-- ---------------------------------------------------------------------

ALTER TABLE pilot_instances           ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion_profile         ENABLE ROW LEVEL SECURITY;
ALTER TABLE supported_person_profile  ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vaults             ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vault_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_store              ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_state               ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- pilot_instances: tenant-scoped for lylo_app / lylo_admin; a role-
-- scoped bootstrap policy for lylo_runtime so a future env-first GM-16
-- boot can resolve its pilot id without first needing to set
-- app.pilot_instance_id. Safe under single-tenant: the runtime owns one
-- DATABASE_URL pointing at one pilot.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS pilot_instances_tenant_scope ON pilot_instances;
CREATE POLICY pilot_instances_tenant_scope ON pilot_instances FOR SELECT
  USING (id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS pilot_instances_runtime_bootstrap ON pilot_instances;
CREATE POLICY pilot_instances_runtime_bootstrap ON pilot_instances FOR SELECT
  TO lylo_runtime
  USING (true);

-- ---------------------------------------------------------------------
-- Tenant-scoped SELECT policies on the remaining client-scoped tables.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS users_tenant_scope ON users;
CREATE POLICY users_tenant_scope ON users FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS companion_profile_tenant_scope ON companion_profile;
CREATE POLICY companion_profile_tenant_scope ON companion_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS supported_person_profile_tenant_scope ON supported_person_profile;
CREATE POLICY supported_person_profile_tenant_scope ON supported_person_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS setup_state_tenant_scope ON setup_state;
CREATE POLICY setup_state_tenant_scope ON setup_state FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- circle_contacts: senior, the contact themselves, or an admin in the
-- same pilot.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS circle_contacts_senior ON circle_contacts;
CREATE POLICY circle_contacts_senior ON circle_contacts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND senior_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS circle_contacts_contact ON circle_contacts;
CREATE POLICY circle_contacts_contact ON circle_contacts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND contact_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS circle_contacts_admin ON circle_contacts;
CREATE POLICY circle_contacts_admin ON circle_contacts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- ---------------------------------------------------------------------
-- memory_vaults / memory_vault_sessions: vault content is private to
-- the supported person. No admin policy — admins cannot read the PIN
-- hash or session state.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS memory_vaults_owner ON memory_vaults;
CREATE POLICY memory_vaults_owner ON memory_vaults FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS memory_vault_sessions_owner ON memory_vault_sessions;
CREATE POLICY memory_vault_sessions_owner ON memory_vault_sessions FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- memory_store: owner, admissible family_shared with circle permission,
-- or admissible password_locked with an open session. NO admin policy
-- — admins do not see private memories (OQ-14.2).
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS memory_store_owner ON memory_store;
CREATE POLICY memory_store_owner ON memory_store FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS memory_store_family_shared ON memory_store;
CREATE POLICY memory_store_family_shared ON memory_store FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND visibility_level = 'family_shared'
    AND admissibility_state = 'admissible'
    AND EXISTS (
      SELECT 1 FROM circle_contacts cc
      WHERE cc.pilot_instance_id = memory_store.pilot_instance_id
        AND cc.senior_user_id = memory_store.owning_user_id
        AND cc.contact_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND cc.permission_scope -> 'visibility_levels' ? 'family_shared'
    )
  );

DROP POLICY IF EXISTS memory_store_password_locked ON memory_store;
CREATE POLICY memory_store_password_locked ON memory_store FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND visibility_level = 'password_locked'
    AND vault_id IS NOT NULL
    AND admissibility_state = 'admissible'
    AND EXISTS (
      SELECT 1 FROM memory_vault_sessions s
      WHERE s.vault_id = memory_store.vault_id
        AND s.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
    )
  );

-- memory_store INSERT: only for the connecting user's own memories.
DROP POLICY IF EXISTS memory_store_insert_own ON memory_store;
CREATE POLICY memory_store_insert_own ON memory_store FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- governance_audit_log: admin sees all (tenant-scoped); a user sees
-- events targeted at them. Inserts allowed for in-pilot users; the
-- append-only trigger blocks UPDATE/DELETE.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS governance_audit_log_admin ON governance_audit_log;
CREATE POLICY governance_audit_log_admin ON governance_audit_log FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS governance_audit_log_target ON governance_audit_log;
CREATE POLICY governance_audit_log_target ON governance_audit_log FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND target_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS governance_audit_log_insert ON governance_audit_log;
CREATE POLICY governance_audit_log_insert ON governance_audit_log FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Rollback:
-- DROP POLICY IF EXISTS governance_audit_log_insert ON governance_audit_log;
-- DROP POLICY IF EXISTS governance_audit_log_target ON governance_audit_log;
-- DROP POLICY IF EXISTS governance_audit_log_admin ON governance_audit_log;
-- DROP POLICY IF EXISTS memory_store_insert_own ON memory_store;
-- DROP POLICY IF EXISTS memory_store_password_locked ON memory_store;
-- DROP POLICY IF EXISTS memory_store_family_shared ON memory_store;
-- DROP POLICY IF EXISTS memory_store_owner ON memory_store;
-- DROP POLICY IF EXISTS memory_vault_sessions_owner ON memory_vault_sessions;
-- DROP POLICY IF EXISTS memory_vaults_owner ON memory_vaults;
-- DROP POLICY IF EXISTS circle_contacts_admin ON circle_contacts;
-- DROP POLICY IF EXISTS circle_contacts_contact ON circle_contacts;
-- DROP POLICY IF EXISTS circle_contacts_senior ON circle_contacts;
-- DROP POLICY IF EXISTS setup_state_tenant_scope ON setup_state;
-- DROP POLICY IF EXISTS supported_person_profile_tenant_scope ON supported_person_profile;
-- DROP POLICY IF EXISTS companion_profile_tenant_scope ON companion_profile;
-- DROP POLICY IF EXISTS users_tenant_scope ON users;
-- DROP POLICY IF EXISTS pilot_instances_runtime_bootstrap ON pilot_instances;
-- DROP POLICY IF EXISTS pilot_instances_tenant_scope ON pilot_instances;
-- ALTER TABLE setup_state               DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE governance_audit_log      DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE memory_store              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE memory_vault_sessions     DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE memory_vaults             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE circle_contacts           DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE supported_person_profile  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE companion_profile         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE users                     DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE pilot_instances           DISABLE ROW LEVEL SECURITY;
-- Roles are intentionally NOT dropped on rollback — they may be
-- referenced by GM-16 connection strings already in production.
