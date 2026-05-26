-- =====================================================================
-- CLASP-ENDOR MASTER MIGRATION - ALL TABLES (001-015)
-- =====================================================================
-- Run this complete script in Supabase SQL Editor
-- Contains ALL migrations required by the codebase

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- 001: BASELINE - Tenancy and identity
-- =====================================================================

CREATE TABLE IF NOT EXISTS pilot_instances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                 UUID NOT NULL DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  username           TEXT NOT NULL,
  role               TEXT NOT NULL
    CHECK (role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, username)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_one_senior_per_pilot
  ON users (pilot_instance_id) WHERE role = 'senior';

-- =====================================================================
-- 002: PROFILES - Companion and person configuration
-- =====================================================================

CREATE TABLE IF NOT EXISTS companion_profile (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  companion_name     TEXT NOT NULL,
  persona            JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice              JSONB NOT NULL DEFAULT '{}'::jsonb,
  safety             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pilot_instance_id)
);

CREATE TABLE IF NOT EXISTS supported_person_profile (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  user_id            UUID NOT NULL,
  display_name       TEXT NOT NULL,
  timezone           TEXT,
  locale             TEXT,
  preferences        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pilot_instance_id),
  UNIQUE (user_id),
  FOREIGN KEY (pilot_instance_id, user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS circle_contacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  senior_user_id     UUID NOT NULL,
  contact_user_id    UUID NOT NULL,
  permission_scope   JSONB NOT NULL DEFAULT '{"visibility_levels": []}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (senior_user_id, contact_user_id),
  FOREIGN KEY (pilot_instance_id, senior_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, contact_user_id)
    REFERENCES users (pilot_instance_id, id)
);

-- =====================================================================
-- 003: VAULTS - Password-locked memory infrastructure
-- =====================================================================

CREATE TABLE IF NOT EXISTS memory_vaults (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id     UUID NOT NULL REFERENCES pilot_instances(id),
  user_id               UUID NOT NULL,
  pin_hash              TEXT NOT NULL,
  pin_salt              TEXT NOT NULL,
  lockout_until         TIMESTAMPTZ,
  failed_attempt_count  INT NOT NULL DEFAULT 0,
  last_unlocked_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id),
  UNIQUE (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS memory_vault_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL,
  vault_id           UUID NOT NULL,
  user_id            UUID NOT NULL,
  unlocked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  FOREIGN KEY (pilot_instance_id, user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, vault_id)
    REFERENCES memory_vaults (pilot_instance_id, id)
);

-- =====================================================================
-- 006: SETUP STATE - Onboarding tracking (before memory_store reference)
-- =====================================================================

CREATE TABLE IF NOT EXISTS setup_state (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  step_key           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'complete')),
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pilot_instance_id, step_key)
);

-- =====================================================================
-- 004: MEMORY STORE with 015 enhancement (memory_status)
-- =====================================================================

CREATE TABLE IF NOT EXISTS memory_store (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  owning_user_id       UUID NOT NULL,
  content              TEXT NOT NULL,
  provenance           TEXT NOT NULL
    CHECK (provenance IN ('VERIFIED_FACT', 'USER_STATED', 'AI_INFERRED')),
  visibility_level     TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility_level IN ('private', 'family_shared', 'password_locked')),
  admissibility_state  TEXT NOT NULL DEFAULT 'admissible'
    CHECK (admissibility_state IN ('admissible', 'inadmissible')),
  memory_status        TEXT NOT NULL DEFAULT 'WORKING_ACTIVE'
    CHECK (memory_status IN ('WORKING_ACTIVE', 'GOVERNANCE_PENDING', 'VERIFIED', 'SUPERSEDED')),
  superseded_by        UUID REFERENCES memory_store(id),
  vault_id             UUID,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (visibility_level <> 'password_locked' OR vault_id IS NOT NULL),
  FOREIGN KEY (pilot_instance_id, owning_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, vault_id)
    REFERENCES memory_vaults (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

-- Memory store immutability trigger
CREATE OR REPLACE FUNCTION trg_memory_store_immutable_columns() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id <> NEW.id
     OR OLD.pilot_instance_id <> NEW.pilot_instance_id
     OR OLD.owning_user_id <> NEW.owning_user_id
     OR OLD.content <> NEW.content
     OR OLD.provenance <> NEW.provenance
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'memory_store: immutable columns cannot be changed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS memory_store_immutable_columns ON memory_store;
CREATE TRIGGER memory_store_immutable_columns
  BEFORE UPDATE ON memory_store
  FOR EACH ROW EXECUTE FUNCTION trg_memory_store_immutable_columns();

-- Add missing columns and constraints for existing tables
DO $$
BEGIN
  -- Add memory_status column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_store' AND column_name = 'memory_status'
  ) THEN
    ALTER TABLE memory_store
    ADD COLUMN memory_status TEXT NOT NULL DEFAULT 'WORKING_ACTIVE';

    ALTER TABLE memory_store
    ADD CONSTRAINT memory_status_check
    CHECK (memory_status IN ('WORKING_ACTIVE', 'GOVERNANCE_PENDING', 'VERIFIED', 'SUPERSEDED'));
  END IF;

  -- Add pilot_instance_id, id UNIQUE constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'memory_store' AND constraint_name LIKE '%pilot_instance_id%id%'
  ) THEN
    ALTER TABLE memory_store
    ADD CONSTRAINT memory_store_pilot_id_uk UNIQUE (pilot_instance_id, id);
  END IF;

  -- Ensure governance_review_queue has required UNIQUE constraint
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'governance_review_queue')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_name = 'governance_review_queue' AND constraint_name LIKE '%pilot_instance_id%id%'
     ) THEN
    ALTER TABLE governance_review_queue
    ADD CONSTRAINT governance_review_queue_pilot_id_uk UNIQUE (pilot_instance_id, id);
  END IF;

END $$;

CREATE INDEX IF NOT EXISTS idx_memory_store_status_active
ON memory_store (pilot_instance_id, owning_user_id, memory_status, created_at DESC)
WHERE memory_status = 'WORKING_ACTIVE' AND active = true;

-- =====================================================================
-- 005: AUDIT LOG - Governance audit trail
-- =====================================================================

CREATE TABLE IF NOT EXISTS governance_audit_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  memory_id          UUID REFERENCES memory_store(id),
  target_user_id     UUID,
  event_type         TEXT NOT NULL,
  actor_user_id      UUID NOT NULL,
  actor_role         TEXT NOT NULL
    CHECK (actor_role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  old_visibility     TEXT,
  new_visibility     TEXT,
  reason             TEXT,
  outcome            TEXT NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'masked', 'partial')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (pilot_instance_id, actor_user_id)
    REFERENCES users (pilot_instance_id, id)
);

-- Audit log append-only trigger
CREATE OR REPLACE FUNCTION trg_governance_audit_log_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_audit_log is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_audit_log_append_only ON governance_audit_log; CREATE TRIGGER governance_audit_log_append_only
  BEFORE UPDATE OR DELETE ON governance_audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_governance_audit_log_append_only();

-- =====================================================================
-- 008: REVIEW QUEUE - Review staging
-- =====================================================================

CREATE TABLE IF NOT EXISTS governance_review_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  decision_intent_type TEXT NOT NULL
    CHECK (decision_intent_type IN (
      'response.deliver', 'memory.candidate.create', 'memory.visibility.promote',
      'memory.retract', 'memory.supersede', 'vault.session.open',
      'vault.session.revoke', 'external.side_effect')),
  decision_reason      TEXT NOT NULL
    CHECK (decision_reason IN (
      'response_delivery_permitted', 'ai_inferred_requires_review', 'user_stated_requires_review',
      'verified_fact_self_promotion_forbidden', 'visibility_promotion_requires_authority',
      'retraction_infrastructure_not_available', 'supersession_infrastructure_not_available',
      'vault_infrastructure_not_available', 'external_side_effects_not_authorized',
      'unknown_intent_type', 'malformed_intent_payload')),
  decision_policy_ref  TEXT NOT NULL,
  proposer_user_id     UUID NOT NULL,
  proposer_role        TEXT NOT NULL
    CHECK (proposer_role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  payload_summary      JSONB,
  evidence_summary     JSONB,
  status               TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status = 'pending_review'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (pilot_instance_id, proposer_user_id)
    REFERENCES users (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

-- =====================================================================
-- 009: REVIEW DECISIONS - Review outcomes
-- =====================================================================

CREATE TABLE IF NOT EXISTS governance_review_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id   UUID NOT NULL REFERENCES pilot_instances(id),
  review_queue_id     UUID NOT NULL,
  reviewer_user_id    UUID NOT NULL,
  reviewer_role       TEXT NOT NULL CHECK (reviewer_role = 'admin'),
  review_outcome      TEXT NOT NULL CHECK (review_outcome IN ('approved', 'rejected')),
  review_reason       TEXT NOT NULL
    CHECK (review_reason IN (
      'approved_admin_review', 'rejected_insufficient_evidence', 'rejected_policy_violation',
      'rejected_duplicate', 'rejected_admin_review')),
  reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_queue_id),
  FOREIGN KEY (pilot_instance_id, reviewer_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, review_queue_id)
    REFERENCES governance_review_queue (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

-- =====================================================================
-- 010-014: EXECUTION WORKFLOW TABLES
-- =====================================================================

CREATE TABLE IF NOT EXISTS governance_execution_authorizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id     UUID NOT NULL REFERENCES pilot_instances(id),
  review_decision_id    UUID NOT NULL,
  authorized_by_user_id UUID NOT NULL,
  authorized_by_role    TEXT NOT NULL CHECK (authorized_by_role = 'admin'),
  authorization_scope   TEXT NOT NULL
    CHECK (authorization_scope IN ('response_delivery', 'memory_candidate_creation',
                                   'memory_visibility_promotion', 'external_side_effect')),
  authorization_reason  TEXT NOT NULL CHECK (authorization_reason = 'admin_explicit_authorization'),
  authorized_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_decision_id),
  FOREIGN KEY (pilot_instance_id, authorized_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, review_decision_id)
    REFERENCES governance_review_decisions (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS governance_execution_claims (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id         UUID NOT NULL REFERENCES pilot_instances(id),
  execution_authorization_id UUID NOT NULL,
  authorization_scope       TEXT NOT NULL
    CHECK (authorization_scope IN ('response_delivery', 'memory_candidate_creation',
                                   'memory_visibility_promotion', 'external_side_effect')),
  execution_surface         TEXT NOT NULL
    CHECK (execution_surface IN ('future_response_delivery', 'future_memory_candidate_creation',
                                 'future_memory_visibility_promotion', 'future_external_side_effect')),
  claimed_by_user_id        UUID NOT NULL,
  claimed_by_role           TEXT NOT NULL CHECK (claimed_by_role = 'admin'),
  claimed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_authorization_id),
  FOREIGN KEY (pilot_instance_id, claimed_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_authorization_id)
    REFERENCES governance_execution_authorizations (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS governance_execution_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id   UUID NOT NULL REFERENCES pilot_instances(id),
  execution_claim_id  UUID NOT NULL,
  authorization_scope TEXT NOT NULL
    CHECK (authorization_scope IN ('response_delivery', 'memory_candidate_creation',
                                   'memory_visibility_promotion', 'external_side_effect')),
  execution_surface   TEXT NOT NULL
    CHECK (execution_surface IN ('future_response_delivery', 'future_memory_candidate_creation',
                                 'future_memory_visibility_promotion', 'future_external_side_effect')),
  attempted_by_user_id UUID NOT NULL,
  attempted_by_role   TEXT NOT NULL CHECK (attempted_by_role = 'admin'),
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_claim_id),
  FOREIGN KEY (pilot_instance_id, attempted_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_claim_id)
    REFERENCES governance_execution_claims (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS governance_execution_outcomes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  execution_attempt_id UUID NOT NULL,
  authorization_scope  TEXT NOT NULL
    CHECK (authorization_scope IN ('response_delivery', 'memory_candidate_creation',
                                   'memory_visibility_promotion', 'external_side_effect')),
  execution_surface    TEXT NOT NULL
    CHECK (execution_surface IN ('future_response_delivery', 'future_memory_candidate_creation',
                                 'future_memory_visibility_promotion', 'future_external_side_effect')),
  observed_outcome     TEXT NOT NULL
    CHECK (observed_outcome IN ('execution_completed', 'execution_failed',
                                'execution_partially_completed', 'execution_not_attempted')),
  outcome_details      JSONB,
  recorded_by_user_id  UUID NOT NULL,
  recorded_by_role     TEXT NOT NULL CHECK (recorded_by_role = 'admin'),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_attempt_id),
  FOREIGN KEY (pilot_instance_id, recorded_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_attempt_id)
    REFERENCES governance_execution_attempts (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

CREATE TABLE IF NOT EXISTS governance_execution_verifications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  execution_outcome_id UUID NOT NULL,
  verified_by_user_id  UUID NOT NULL,
  verified_by_role     TEXT NOT NULL CHECK (verified_by_role = 'admin'),
  verification_status  TEXT NOT NULL
    CHECK (verification_status IN ('outcome_verified', 'outcome_disputed')),
  verification_reason  TEXT NOT NULL
    CHECK (verification_reason IN ('admin_independent_verification', 'admin_dispute_recorded')),
  verified_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_outcome_id),
  FOREIGN KEY (pilot_instance_id, verified_by_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, execution_outcome_id)
    REFERENCES governance_execution_outcomes (pilot_instance_id, id)
);

-- =====================================================================
-- APPEND-ONLY TRIGGERS for governance tables
-- =====================================================================

CREATE OR REPLACE FUNCTION trg_governance_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END $$;

-- Apply to all governance tables
DROP TRIGGER IF EXISTS governance_review_queue_append_only ON governance_review_queue; CREATE TRIGGER governance_review_queue_append_only
  BEFORE UPDATE OR DELETE ON governance_review_queue
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_review_decisions_append_only ON governance_review_decisions; CREATE TRIGGER governance_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON governance_review_decisions
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_execution_authorizations_append_only ON governance_execution_authorizations; CREATE TRIGGER governance_execution_authorizations_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_authorizations
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_execution_claims_append_only ON governance_execution_claims; CREATE TRIGGER governance_execution_claims_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_claims
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_execution_attempts_append_only ON governance_execution_attempts; CREATE TRIGGER governance_execution_attempts_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_execution_outcomes_append_only ON governance_execution_outcomes; CREATE TRIGGER governance_execution_outcomes_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_outcomes
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

DROP TRIGGER IF EXISTS governance_execution_verifications_append_only ON governance_execution_verifications; CREATE TRIGGER governance_execution_verifications_append_only
  BEFORE UPDATE OR DELETE ON governance_execution_verifications
  FOR EACH ROW EXECUTE FUNCTION trg_governance_append_only();

-- =====================================================================
-- 007: RLS POLICIES AND ROLES - CRITICAL SECURITY
-- =====================================================================

-- Create database roles
DO $$ BEGIN CREATE ROLE lylo_runtime NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE lylo_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE lylo_setup NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE lylo_setup BYPASSRLS;
DO $$ BEGIN CREATE ROLE lylo_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schema usage grants
GRANT USAGE ON SCHEMA public TO lylo_runtime, lylo_app, lylo_setup, lylo_admin;

-- Table grants for lylo_runtime (config loader)
GRANT SELECT ON pilot_instances, companion_profile, supported_person_profile, setup_state TO lylo_runtime;

-- Table grants for lylo_app (main application)
GRANT SELECT ON pilot_instances, users, companion_profile, supported_person_profile,
                circle_contacts, memory_vaults, memory_vault_sessions, memory_store,
                governance_audit_log, governance_review_queue, governance_review_decisions,
                governance_execution_authorizations, governance_execution_claims,
                governance_execution_attempts, governance_execution_outcomes,
                governance_execution_verifications TO lylo_app;

GRANT INSERT ON memory_store, governance_audit_log, memory_vault_sessions,
                governance_review_queue, governance_review_decisions,
                governance_execution_authorizations, governance_execution_claims,
                governance_execution_attempts, governance_execution_outcomes,
                governance_execution_verifications TO lylo_app;

GRANT UPDATE (revoked_at) ON memory_vault_sessions TO lylo_app;

-- Table grants for lylo_setup
GRANT INSERT, SELECT ON pilot_instances, users, companion_profile, supported_person_profile, setup_state TO lylo_setup;

-- Table grants for lylo_admin
GRANT SELECT ON pilot_instances, users, companion_profile, supported_person_profile,
                circle_contacts, memory_vaults, memory_vault_sessions,
                governance_audit_log, setup_state, governance_review_queue,
                governance_review_decisions, governance_execution_authorizations,
                governance_execution_claims, governance_execution_attempts,
                governance_execution_outcomes, governance_execution_verifications TO lylo_admin;

-- Enable RLS on all tables
ALTER TABLE pilot_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE companion_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE supported_person_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_vault_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_execution_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_execution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_execution_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_execution_verifications ENABLE ROW LEVEL SECURITY;

-- Essential RLS policies (tenant-scoped)
DROP POLICY IF EXISTS pilot_instances_tenant_scope ON pilot_instances; CREATE POLICY pilot_instances_tenant_scope ON pilot_instances FOR SELECT
  USING (id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS pilot_instances_runtime_bootstrap ON pilot_instances; CREATE POLICY pilot_instances_runtime_bootstrap ON pilot_instances FOR SELECT
  TO lylo_runtime USING (true);

DROP POLICY IF EXISTS users_tenant_scope ON users; CREATE POLICY users_tenant_scope ON users FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS companion_profile_tenant_scope ON companion_profile; CREATE POLICY companion_profile_tenant_scope ON companion_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS supported_person_profile_tenant_scope ON supported_person_profile; CREATE POLICY supported_person_profile_tenant_scope ON supported_person_profile FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

DROP POLICY IF EXISTS setup_state_tenant_scope ON setup_state; CREATE POLICY setup_state_tenant_scope ON setup_state FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid);

-- Memory store policies
DROP POLICY IF EXISTS memory_store_owner ON memory_store; CREATE POLICY memory_store_owner ON memory_store FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS memory_store_insert_own ON memory_store; CREATE POLICY memory_store_insert_own ON memory_store FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Audit log policies
DROP POLICY IF EXISTS governance_audit_log_admin ON governance_audit_log; CREATE POLICY governance_audit_log_admin ON governance_audit_log FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

DROP POLICY IF EXISTS governance_audit_log_insert ON governance_audit_log; CREATE POLICY governance_audit_log_insert ON governance_audit_log FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Review queue policies
DROP POLICY IF EXISTS review_queue_insert_own ON governance_review_queue; CREATE POLICY review_queue_insert_own ON governance_review_queue FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND proposer_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS review_queue_admin ON governance_review_queue; CREATE POLICY review_queue_admin ON governance_review_queue FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Basic policies for execution tables (admin-only)
DROP POLICY IF EXISTS execution_admin_select ON governance_execution_authorizations; CREATE POLICY execution_admin_select ON governance_execution_authorizations FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
         AND current_setting('app.user_role', true) = 'admin');

DROP POLICY IF EXISTS execution_admin_select ON governance_execution_authorizations; CREATE POLICY execution_admin_select ON governance_execution_claims FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
         AND current_setting('app.user_role', true) = 'admin');

DROP POLICY IF EXISTS execution_admin_select ON governance_execution_authorizations; CREATE POLICY execution_admin_select ON governance_execution_attempts FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
         AND current_setting('app.user_role', true) = 'admin');

DROP POLICY IF EXISTS execution_admin_select ON governance_execution_authorizations; CREATE POLICY execution_admin_select ON governance_execution_outcomes FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
         AND current_setting('app.user_role', true) = 'admin');

DROP POLICY IF EXISTS execution_admin_select ON governance_execution_authorizations; CREATE POLICY execution_admin_select ON governance_execution_verifications FOR SELECT
  USING (pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
         AND current_setting('app.user_role', true) = 'admin');

-- =====================================================================
-- SUCCESS CONFIRMATION
-- =====================================================================

SELECT 'CLASP-ENDOR MASTER MIGRATION COMPLETE - All tables 001-015 created successfully' as status;


