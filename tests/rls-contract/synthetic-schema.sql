-- Synthetic RLS / privacy contract schema.
--
-- Structurally equivalent to db/migrations/0*.sql but minimal — no
-- application-level invariant triggers (immutability, append-only)
-- because the contract is about access control, not write integrity.
-- Fictional only; ports nothing client-specific.
--
-- This file is consumed by tests/rls-contract/run-contract.js after the
-- runner drops and recreates the public schema. It is never applied to
-- a real instance database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE pilot_instances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
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

CREATE UNIQUE INDEX users_one_senior_per_pilot
  ON users (pilot_instance_id) WHERE role = 'senior';

CREATE TABLE companion_profile (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  companion_name     TEXT NOT NULL,
  persona            JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice              JSONB NOT NULL DEFAULT '{}'::jsonb,
  safety             JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (pilot_instance_id)
);

CREATE TABLE supported_person_profile (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  user_id            UUID NOT NULL,
  display_name       TEXT NOT NULL,
  UNIQUE (pilot_instance_id),
  UNIQUE (user_id),
  FOREIGN KEY (pilot_instance_id, user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE circle_contacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  senior_user_id     UUID NOT NULL,
  contact_user_id    UUID NOT NULL,
  permission_scope   JSONB NOT NULL DEFAULT '{"visibility_levels": []}'::jsonb,
  UNIQUE (senior_user_id, contact_user_id),
  FOREIGN KEY (pilot_instance_id, senior_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, contact_user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE memory_vaults (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id     UUID NOT NULL REFERENCES pilot_instances(id),
  user_id               UUID NOT NULL,
  pin_hash              TEXT NOT NULL,
  pin_salt              TEXT NOT NULL,
  lockout_until         TIMESTAMPTZ,
  failed_attempt_count  INT NOT NULL DEFAULT 0,
  UNIQUE (user_id),
  UNIQUE (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE memory_vault_sessions (
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

CREATE TABLE memory_store (
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
  vault_id             UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (visibility_level <> 'password_locked' OR vault_id IS NOT NULL),
  FOREIGN KEY (pilot_instance_id, owning_user_id)
    REFERENCES users (pilot_instance_id, id),
  FOREIGN KEY (pilot_instance_id, vault_id)
    REFERENCES memory_vaults (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, id)
);

CREATE TABLE governance_audit_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  memory_id          UUID REFERENCES memory_store(id),
  target_user_id     UUID,
  event_type         TEXT NOT NULL,
  actor_user_id      UUID NOT NULL,
  actor_role         TEXT NOT NULL
    CHECK (actor_role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  outcome            TEXT NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'masked', 'partial')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (pilot_instance_id, actor_user_id)
    REFERENCES users (pilot_instance_id, id)
);

CREATE TABLE setup_state (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  step_key           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'complete')),
  completed_at       TIMESTAMPTZ,
  UNIQUE (pilot_instance_id, step_key)
);
