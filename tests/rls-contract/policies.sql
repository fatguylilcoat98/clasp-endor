-- Candidate RLS policies for the synthetic schema.
--
-- These are the policies GM-15 will apply to the real
-- db/migrations/ schema, validated here first against the synthetic
-- shape. The contract suite (run-contract.js) verifies the access
-- matrix every PR.
--
-- Session-variable convention (set by the connecting application
-- per request):
--   app.pilot_instance_id  — the connecting user's pilot scope
--   app.user_id            — the connecting user
--   app.user_role          — their role token ('senior' / 'family' /
--                            'caregiver' / 'admin' / 'system')
--
-- DB-role model (created here for testing; GM-15 will introduce these
-- to the real cluster):
--   lylo_runtime  — config loader; SELECT on the four config tables only
--   lylo_app      — memory-governance runtime; SELECT/INSERT gated by RLS
--   lylo_setup    — provisioning script; BYPASSRLS so it can seed
--   lylo_admin    — operator; broader SELECT, but no private memories

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
-- in it (errors as "relation does not exist"). Every Lylo role needs
-- USAGE so the table-level GRANTs below can take effect.
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
-- Tenant-scoped SELECT policies.
-- ---------------------------------------------------------------------

CREATE POLICY pilot_instances_tenant_scope ON pilot_instances FOR SELECT
  USING (id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

CREATE POLICY users_tenant_scope ON users FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

CREATE POLICY companion_profile_tenant_scope ON companion_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

CREATE POLICY supported_person_profile_tenant_scope ON supported_person_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

CREATE POLICY setup_state_tenant_scope ON setup_state FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- circle_contacts: senior, the contact themselves, or an admin in the
-- same pilot.
-- ---------------------------------------------------------------------

CREATE POLICY circle_contacts_senior ON circle_contacts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND senior_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY circle_contacts_contact ON circle_contacts FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND contact_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

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

CREATE POLICY memory_vaults_owner ON memory_vaults FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

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

CREATE POLICY memory_store_owner ON memory_store FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

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
CREATE POLICY memory_store_insert_own ON memory_store FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- governance_audit_log: admin sees all (tenant-scoped); a user sees
-- events targeted at them. Inserts allowed for in-pilot users; the
-- append-only trigger blocks UPDATE/DELETE in the real schema.
-- ---------------------------------------------------------------------

CREATE POLICY governance_audit_log_admin ON governance_audit_log FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

CREATE POLICY governance_audit_log_target ON governance_audit_log FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND target_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

CREATE POLICY governance_audit_log_insert ON governance_audit_log FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
