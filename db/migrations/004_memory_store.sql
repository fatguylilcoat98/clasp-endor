-- Plan: the governed memory store. Each row is one memory — content plus
-- its provenance, visibility, and admissibility classification.
--
-- GM-3 ships the STRUCTURAL model only:
--   - provenance enum: the locked 3-class model
--   - visibility enum: private / family_shared / password_locked
--   - admissibility_state column + superseded_by self-reference
--   - an immutability trigger on identity / content / provenance columns
--
-- The full admissibility lifecycle (the proposed/pending/verified flow,
-- dispute handling, the authority-validation workflow, the review queue)
-- is deferred to a later migration. RLS policies are deferred to the RLS
-- contract port.

CREATE TABLE memory_store (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  owning_user_id       UUID NOT NULL,
  content              TEXT NOT NULL,
  -- Locked 3-class provenance model
  -- (docs/governance/source-of-truth-memory-policy.md).
  provenance           TEXT NOT NULL
    CHECK (provenance IN ('VERIFIED_FACT', 'USER_STATED', 'AI_INFERRED')),
  -- Visibility model. 'family_shared' = visible to the authorized circle.
  visibility_level     TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility_level IN ('private', 'family_shared', 'password_locked')),
  -- Admissibility: whether the memory may enter governed context. GM-3
  -- ships a minimal two-state column; the lifecycle workflow is a later
  -- migration.
  admissibility_state  TEXT NOT NULL DEFAULT 'admissible'
    CHECK (admissibility_state IN ('admissible', 'inadmissible')),
  -- Supersession link: a correction inserts a new row that points back
  -- to the row it supersedes. Editing in place is forbidden.
  superseded_by        UUID REFERENCES memory_store(id),
  vault_id             UUID,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A password_locked memory must be attached to a vault.
  CHECK (visibility_level <> 'password_locked' OR vault_id IS NOT NULL),
  FOREIGN KEY (pilot_instance_id, owning_user_id)
    REFERENCES users (pilot_instance_id, id),
  -- vault_id is composite-FK scoped to the same pilot.
  FOREIGN KEY (pilot_instance_id, vault_id)
    REFERENCES memory_vaults (pilot_instance_id, id),
  -- Allow derived-table composite FKs in later migrations.
  UNIQUE (pilot_instance_id, id)
);

-- Immutability: a memory's identity, owner, origin content and provenance,
-- and creation time never change after insert. Correction is supersession
-- — a new row — never an in-place edit. visibility_level,
-- admissibility_state, superseded_by, vault_id, active and updated_at
-- remain mutable.
CREATE FUNCTION trg_memory_store_immutable_columns() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id                IS DISTINCT FROM OLD.id
     OR NEW.pilot_instance_id IS DISTINCT FROM OLD.pilot_instance_id
     OR NEW.owning_user_id    IS DISTINCT FROM OLD.owning_user_id
     OR NEW.content           IS DISTINCT FROM OLD.content
     OR NEW.provenance        IS DISTINCT FROM OLD.provenance
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'memory_store: id, pilot_instance_id, owning_user_id, content, provenance and created_at are immutable; correct a memory by supersession, not in-place UPDATE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER memory_store_immutable_columns
  BEFORE UPDATE ON memory_store
  FOR EACH ROW EXECUTE FUNCTION trg_memory_store_immutable_columns();

-- Rollback:
-- DROP TABLE IF EXISTS memory_store;       -- drops the trigger with it
-- DROP FUNCTION IF EXISTS trg_memory_store_immutable_columns();
