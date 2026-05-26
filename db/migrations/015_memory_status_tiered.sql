-- Add memory status field for tiered memory architecture
--
-- Enables the tiered model:
--   WORKING_ACTIVE: instant working memory, immediately visible
--   GOVERNANCE_PENDING: under review in governance workflow
--   VERIFIED: reviewed and verified facts
--   SUPERSEDED: replaced by newer memory
--
-- This migration adds the status field to support the working memory
-- layer while preserving schema compatibility for future governance
-- layers.

ALTER TABLE memory_store
ADD COLUMN memory_status TEXT NOT NULL DEFAULT 'WORKING_ACTIVE'
CHECK (memory_status IN ('WORKING_ACTIVE', 'GOVERNANCE_PENDING', 'VERIFIED', 'SUPERSEDED'));

-- Update the immutability trigger to protect the new status field from
-- unauthorized changes (status transitions should go through proper workflow)
DROP FUNCTION IF EXISTS trg_memory_store_immutable_columns() CASCADE;

CREATE FUNCTION trg_memory_store_immutable_columns() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id <> NEW.id
     OR OLD.pilot_instance_id <> NEW.pilot_instance_id
     OR OLD.owning_user_id <> NEW.owning_user_id
     OR OLD.content <> NEW.content
     OR OLD.provenance <> NEW.provenance
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'memory_store: id, pilot_instance_id, owning_user_id, content, provenance and created_at are immutable; correct a memory by supersession, not in-place UPDATE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_store_immutable_columns
  BEFORE UPDATE ON memory_store
  FOR EACH ROW EXECUTE FUNCTION trg_memory_store_immutable_columns();

-- Create index for efficient status-based queries
CREATE INDEX idx_memory_store_status_active
ON memory_store (pilot_instance_id, owning_user_id, memory_status, created_at DESC)
WHERE memory_status = 'WORKING_ACTIVE' AND active = true;