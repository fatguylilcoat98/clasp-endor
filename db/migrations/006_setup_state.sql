-- Plan: setup / onboarding state. Tracks the progress of Setup Mode for
-- the instance — which onboarding steps have been completed. The Setup
-- wizard (a later GM-series PR) reads and writes this table; GM-3 ships
-- the table shape only.

CREATE TABLE setup_state (
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

-- Rollback:
-- DROP TABLE IF EXISTS setup_state;
