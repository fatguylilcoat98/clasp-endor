-- Plan: vault tables for the password_locked memory tier. memory_vaults
-- holds the PIN hash/salt and lockout state; memory_vault_sessions records
-- an open vault session. PIN verification is performed by the application
-- — the database never receives the plaintext PIN. The vault helper
-- functions and RLS policies land later with the RLS contract port.

CREATE TABLE memory_vaults (
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
  -- Allow client-scoped tables to FK on (pilot_instance_id, id).
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

-- Rollback:
-- DROP TABLE IF EXISTS memory_vault_sessions;
-- DROP TABLE IF EXISTS memory_vaults;
