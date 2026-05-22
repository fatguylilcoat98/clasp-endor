-- Plan: the append-only governance audit log. Records governance-relevant
-- events — memory creation, admissibility transitions, retraction,
-- supersession, visibility changes, authority-validation outcomes, and
-- vault access.
--
-- Append-only is positively enforced: UPDATE and DELETE raise. The
-- event_type vocabulary is intentionally left unconstrained at GM-3 — it
-- is pinned by the RLS contract port, which knows the full event set.
-- RLS policies for who may read / write the log are deferred to that port.

CREATE TABLE governance_audit_log (
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

-- Append-only: the audit log is never updated or deleted in place.
CREATE FUNCTION trg_governance_audit_log_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_audit_log is append-only; % is not permitted', TG_OP;
END $$;

CREATE TRIGGER governance_audit_log_append_only
  BEFORE UPDATE OR DELETE ON governance_audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_governance_audit_log_append_only();

-- Rollback:
-- DROP TABLE IF EXISTS governance_audit_log;   -- drops the trigger with it
-- DROP FUNCTION IF EXISTS trg_governance_audit_log_append_only();
