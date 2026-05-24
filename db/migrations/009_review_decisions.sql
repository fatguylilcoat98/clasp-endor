-- Plan: GM-24 — the review-decision substrate. The first record
-- of a human reviewer's outcome against a pending review_queue
-- item. Second persistence expansion since the process lock,
-- following GM-23's review-queue substrate.
--
-- This migration creates governance_review_decisions, the durable,
-- append-only artifact for the outcome a human admin records when
-- reviewing a pending review-queue item. The substrate is
-- intentionally inert:
--
--   - Append-only via a BEFORE-UPDATE-OR-DELETE trigger.
--   - review_outcome locked to {'approved','rejected'} via CHECK.
--   - review_reason locked to a small vocabulary via CHECK.
--   - reviewer_role locked to 'admin' via CHECK (GM-24 admit only
--     admins; future GMs may widen, paired with the actor + RLS).
--   - UNIQUE(review_queue_id) — each queue item reviewed at most
--     once.
--   - BEFORE-INSERT trigger raises if reviewer_user_id ==
--     governance_review_queue.proposer_user_id (self-review
--     prevention — closes the "admin reviews their own staged
--     item" gap).
--   - No UPDATE / DELETE grants for any role; even granting them
--     would not unlock state transitions because the append-only
--     trigger raises.
--   - SELECT visibility narrowed to admin (all in pilot) and the
--     original proposer (their own queue item's outcome). No
--     family / caregiver / runtime visibility.
--   - lylo_runtime / lylo_setup have no access to this table at
--     all (no grant).
--
-- The contract is: approval is NOT authorization, and authorization
-- is NOT execution. GM-24 records the human review outcome only.
-- No actor consumes review_decision rows operationally in GM-24.
-- Future execution gates (GM-25+) must be separately approved.
--
-- See docs/governance/review-decision-runtime-boundary.md.
--
-- Idempotency: the trigger functions use CREATE OR REPLACE; the
-- triggers and policies use DROP IF EXISTS + CREATE; the table
-- is created without IF NOT EXISTS because re-apply against an
-- existing public schema is not supported (matches the project-
-- wide DROP SCHEMA public CASCADE pattern used by the integration
-- and rls-contract suites).

-- ---------------------------------------------------------------------
-- GM-23's governance_review_queue has only `id` as PRIMARY KEY. The
-- GM-24 composite FK below requires a UNIQUE on
-- (pilot_instance_id, id) — same pattern as users (GM-3). Add it
-- here before the new table references it.
-- ---------------------------------------------------------------------

ALTER TABLE governance_review_queue
  ADD CONSTRAINT governance_review_queue_pilot_id_uk
    UNIQUE (pilot_instance_id, id);

-- ---------------------------------------------------------------------
-- governance_review_decisions — the new append-only artifact.
-- ---------------------------------------------------------------------

CREATE TABLE governance_review_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id   UUID NOT NULL REFERENCES pilot_instances(id),
  review_queue_id     UUID NOT NULL,
  reviewer_user_id    UUID NOT NULL,
  reviewer_role       TEXT NOT NULL
    CHECK (reviewer_role = 'admin'),
  review_outcome      TEXT NOT NULL
    CHECK (review_outcome IN ('approved', 'rejected')),
  review_reason       TEXT NOT NULL
    CHECK (review_reason IN (
      'approved_admin_review',
      'rejected_insufficient_evidence',
      'rejected_policy_violation',
      'rejected_duplicate',
      'rejected_admin_review'
    )),
  reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each queue item reviewed at most once.
  UNIQUE (review_queue_id),
  -- Defense in depth: alongside RLS WITH CHECK, the composite FKs
  -- enforce same-pilot reviewer AND same-pilot queue reference.
  FOREIGN KEY (pilot_instance_id, reviewer_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, review_queue_id)
    REFERENCES governance_review_queue (pilot_instance_id, id),
  -- Composite uniqueness so a future GM can compose-FK to
  -- (pilot_instance_id, id) — same pattern as users + queue above.
  UNIQUE (pilot_instance_id, id)
);

-- ---------------------------------------------------------------------
-- Append-only trigger. Mirrors the GM-23 governance_review_queue
-- pattern: any UPDATE or DELETE raises, even when issued by a
-- superuser. There is no application path that mutates a recorded
-- review.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_review_decisions_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_review_decisions is append-only; % is not permitted', TG_OP;
END $$;

DROP TRIGGER IF EXISTS governance_review_decisions_append_only ON governance_review_decisions;
CREATE TRIGGER governance_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON governance_review_decisions
  FOR EACH ROW EXECUTE FUNCTION trg_governance_review_decisions_append_only();

-- ---------------------------------------------------------------------
-- Self-review prevention trigger. BEFORE INSERT looks up the
-- proposer_user_id of the referenced queue row; if it equals the
-- inserting reviewer_user_id, the trigger raises. This is the
-- authoritative wall — the actor performs the same check for early
-- failure, but a raw INSERT that bypasses the actor still hits
-- this trigger.
--
-- The trigger reads governance_review_queue under whatever role
-- is performing the INSERT. lylo_app has SELECT on the queue (per
-- GM-23 grants) so the lookup succeeds; superuser obviously has
-- access. A hypothetical role without queue SELECT would fail the
-- lookup (which is also defense in depth).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_governance_review_decisions_no_self_review() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  queue_proposer UUID;
BEGIN
  SELECT proposer_user_id INTO queue_proposer
    FROM governance_review_queue
   WHERE id = NEW.review_queue_id
     AND pilot_instance_id = NEW.pilot_instance_id;
  IF NOT FOUND THEN
    -- Composite FK will catch this too, but raise a clear message
    -- before the FK error surfaces.
    RAISE EXCEPTION 'governance_review_decisions: review_queue row % not found in pilot %',
      NEW.review_queue_id, NEW.pilot_instance_id;
  END IF;
  IF queue_proposer = NEW.reviewer_user_id THEN
    RAISE EXCEPTION
      'governance_review_decisions: reviewer % cannot review their own staged item (self-review forbidden)',
      NEW.reviewer_user_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS governance_review_decisions_no_self_review ON governance_review_decisions;
CREATE TRIGGER governance_review_decisions_no_self_review
  BEFORE INSERT ON governance_review_decisions
  FOR EACH ROW EXECUTE FUNCTION trg_governance_review_decisions_no_self_review();

-- ---------------------------------------------------------------------
-- Table-level grants. lylo_app may SELECT and INSERT (the review-
-- decision actor records outcomes; admin + proposer read through
-- this role). lylo_admin may SELECT (operator audit). No UPDATE /
-- DELETE grants for any role. lylo_runtime / lylo_setup have no
-- access.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT ON governance_review_decisions TO lylo_app;
GRANT SELECT          ON governance_review_decisions TO lylo_admin;

-- ---------------------------------------------------------------------
-- Enable RLS. Without an explicit policy, a granted role sees zero
-- rows (default-deny) and INSERT is rejected (no WITH CHECK passes).
-- ---------------------------------------------------------------------

ALTER TABLE governance_review_decisions ENABLE ROW LEVEL SECURITY;

-- INSERT: tenant-scope + no impersonation + admin-only. The
-- reviewer_user_id MUST equal app.user_id; pilot must match;
-- app.user_role must be 'admin'. Any mismatch raises "new row
-- violates row-level security policy".
DROP POLICY IF EXISTS review_decisions_insert_admin ON governance_review_decisions;
CREATE POLICY review_decisions_insert_admin ON governance_review_decisions FOR INSERT
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND reviewer_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- SELECT: admin in the same pilot sees all review decisions.
DROP POLICY IF EXISTS review_decisions_admin_select ON governance_review_decisions;
CREATE POLICY review_decisions_admin_select ON governance_review_decisions FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND current_setting('app.user_role', true) = 'admin'
  );

-- SELECT: the proposer of the underlying queue item sees the
-- outcome of their own staged item (so a senior can learn what
-- a reviewer decided about their proposal). Subquery joins to
-- governance_review_queue and filters by app.user_id; lylo_app
-- has SELECT on the queue, so the subquery resolves.
DROP POLICY IF EXISTS review_decisions_proposer_select ON governance_review_decisions;
CREATE POLICY review_decisions_proposer_select ON governance_review_decisions FOR SELECT
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM governance_review_queue q
       WHERE q.id = governance_review_decisions.review_queue_id
         AND q.pilot_instance_id = governance_review_decisions.pilot_instance_id
         AND q.proposer_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

-- Rollback:
-- DROP POLICY IF EXISTS review_decisions_proposer_select ON governance_review_decisions;
-- DROP POLICY IF EXISTS review_decisions_admin_select    ON governance_review_decisions;
-- DROP POLICY IF EXISTS review_decisions_insert_admin    ON governance_review_decisions;
-- ALTER TABLE governance_review_decisions DISABLE ROW LEVEL SECURITY;
-- REVOKE SELECT         ON governance_review_decisions FROM lylo_admin;
-- REVOKE SELECT, INSERT ON governance_review_decisions FROM lylo_app;
-- DROP TRIGGER IF EXISTS governance_review_decisions_no_self_review ON governance_review_decisions;
-- DROP FUNCTION IF EXISTS trg_governance_review_decisions_no_self_review();
-- DROP TRIGGER IF EXISTS governance_review_decisions_append_only ON governance_review_decisions;
-- DROP FUNCTION IF EXISTS trg_governance_review_decisions_append_only();
-- DROP TABLE IF EXISTS governance_review_decisions;
-- ALTER TABLE governance_review_queue DROP CONSTRAINT IF EXISTS governance_review_queue_pilot_id_uk;
