-- Plan: GM-3 baseline. Establishes the tenancy root (pilot_instances) and
-- the identity table (users) for the Lylo Companion master template. This
-- is the first migration of a clean, greenfield chain — no schema predates
-- it.
--
-- Tenancy model: one database per client (single-tenant) for early
-- deployments. pilot_instance_id is present on every client-scoped table
-- so the schema is multi-tenant-shaped and can be operated shared later
-- with no schema change.
--
-- Row-level security is intentionally NOT enabled here. RLS ENABLE/FORCE
-- and all policies land later as one atomic migration with the RLS
-- contract port.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The tenancy root. In a single-tenant deployment this holds exactly one
-- row; every client-scoped table references it.
CREATE TABLE pilot_instances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The people in one pilot: the supported person (role 'senior'), their
-- authorized circle (family / caregiver), and the operational roles
-- (admin / system).
CREATE TABLE users (
  id                 UUID NOT NULL DEFAULT gen_random_uuid(),
  pilot_instance_id  UUID NOT NULL REFERENCES pilot_instances(id),
  username           TEXT NOT NULL,
  role               TEXT NOT NULL
    CHECK (role IN ('senior', 'family', 'caregiver', 'admin', 'system')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  -- Composite uniqueness so client-scoped tables can FK on
  -- (pilot_instance_id, id) and guarantee a referenced user lives in the
  -- same pilot.
  UNIQUE (pilot_instance_id, id),
  UNIQUE (pilot_instance_id, username)
);

-- One supported person (role 'senior') per pilot.
CREATE UNIQUE INDEX users_one_senior_per_pilot
  ON users (pilot_instance_id) WHERE role = 'senior';

-- Rollback:
-- DROP INDEX IF EXISTS users_one_senior_per_pilot;
-- DROP TABLE IF EXISTS users;
-- DROP TABLE IF EXISTS pilot_instances;
