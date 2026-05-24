-- Plan: GM-23 — the review-queue substrate. The first new table since
-- the GM-3 baseline and the first persistence expansion since the
-- process lock.
--
-- This migration creates governance_review_queue, the durable, append-
-- only artifact for requires_review Decisions returned by the GM-21
-- classifier. The substrate is intentionally inert:
--
--   - Append-only via a BEFORE-UPDATE-OR-DELETE trigger.
--   - status column locked to a single value ('pending_review') via
--     CHECK; status transitions are deliberately not modelled in GM-23.
--   - No UPDATE / DELETE grants for any role; even granting them
--     would not unlock state transitions because the trigger raises
--     and the status CHECK refuses any other value.
--   - SELECT visibility narrowed to proposer (own rows) + admin (all
--     in the pilot) — no family / caregiver / runtime visibility.
--   - lylo_runtime has no access to this table at all (no grant); the
--     runtime configuration loader cannot reach review-queue rows even
--     if it tried.
--
-- The decision_intent_type and decision_reason CHECK lists mirror the
-- GM-21 INTENT_TYPES and REASONS vocabularies. Any future widening of
-- those vocabularies requires a paired migration that expands these
-- CHECK constraints in lockstep — see
-- docs/governance/review-queue-runtime-boundary.md change-control.
--
-- Idempotency: the trigger function uses CREATE OR REPLACE; the
-- trigger and policies use DROP IF EXISTS + CREATE; the table is
-- created without IF NOT EXISTS because re-apply against an existing
-- public schema is not supported (matches the project-wide DROP
-- SCHEMA public CASCADE pattern used by the integration and
-- rls-contract suites).

CREATE TABLE governance_review_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  decision_intent_type TEXT NOT NULL
    CHECK (decision_intent_type IN (
      'response.deliver',
      'memory.candidate.create',
      'memory.visibility.promote',
      'memory.retract',
      'memory.supersede',
      'vault.session.open',
      'vault.session.revoke',
      'external.side_effect'
    )),
  decision_reason      TEXT NOT NULL
    CHECK (decision_reason IN (
      'response_delivery_permitted',
      'ai_inferred_requires_review',
      'user_stated_requires_review',
      'verified_fact_self_promotion_forbidden',
      'visibility_promotion_requires_authority',
      'retraction_infrastructure_not_available',
      'supersession_infrastructure_not_available',
      'vault_infrastructure_not_available',
      'external_side_effects_not_authorized',
      'unknown_intent_type',
      'malformed_intent_payload'
    )),
  decision_policy_ref  TEXT NOT NULL,
  proposer_user_id     UUID NOT NULL,
  proposer_role        TEXT NOT NULL
    CHECK (proposer_role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  payload_summary      JSONB,
  evidence_summary     JSONB,
  status               TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status = 'pending_review'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Composite FK enforces that proposer lives in the same pilot —
  -- defense in depth alongside the tenant-scope RLS policies.
  FOREIGN KEY (pilot_instance_id, proposer_user_id)
    REFERENCES users (pilot_instance_id, id)
);

-- Append-only — the trigger raises on any UPDATE or DELETE, even
-- when issued by a superuser. Matches the governance_audit_log
-- pattern from migration 005.
CREATE OR REPLACE FUNCTION trg_governance_review_queue_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_review_queue is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_review_queue_append_only ON governance_review_queue;
CREATE TRIGGER governance_review_queue_append_only
  BEFORE UPDATE OR DELETE ON governance_review_queue
  FOR EACH ROW EXECUTE FUNCTION trg_governance_review_queue_append_only();

-- Table-level grants. lylo_app may SELECT and INSERT (the review-
-- queue actor stages and the proposer reads own items). lylo_admin
-- may SELECT (admin reviews items in the pilot). No UPDATE / DELETE
-- grants for any role. lylo_runtime / lylo_setup have no access.
GRANT SELECT, INSERT ON governance_review_queue TO lylo_app;
GRANT SELECT          ON governance_review_queue TO lylo_admin;

-- Enable RLS. Without an explicit policy, a granted role sees zero
-- rows (default-deny) and INSERT is rejected (no WITH CHECK passes).
ALTER TABLE governance_review_queue ENABLE ROW LEVEL SECURITY;

-- INSERT: tenant-scope + no impersonation. The proposer_user_id
-- MUST equal app.user_id; the pilot_instance_id MUST equal
-- app.pilot_instance_id. Either mismatch raises "new row violates
-- row-level security policy".
DROP POLICY IF EXISTS review_queue_insert_own ON governance_review_queue;
CREATE POLICY review_queue_insert_own ON governance_review_queue FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND proposer_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- SELECT: the proposer sees own pending items.
DROP POLICY IF EXISTS review_queue_proposer ON governance_review_queue;
CREATE POLICY review_queue_proposer ON governance_review_queue FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND proposer_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- SELECT: admin in the same pilot sees all items.
DROP POLICY IF EXISTS review_queue_admin ON governance_review_queue;
CREATE POLICY review_queue_admin ON governance_review_queue FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- Rollback:
-- DROP POLICY IF EXISTS review_queue_admin    ON governance_review_queue;
-- DROP POLICY IF EXISTS review_queue_proposer ON governance_review_queue;
-- DROP POLICY IF EXISTS review_queue_insert_own ON governance_review_queue;
-- ALTER TABLE governance_review_queue DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT          ON governance_review_queue FROM lylo_admin;
-- REVOKE SELECT, INSERT  ON governance_review_queue FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_review_queue_append_only ON governance_review_queue;
-- DROP FUNCTION IF EXISTS trg_governance_review_queue_append_only();
-- DROP TABLE IF EXISTS governance_review_queue;
