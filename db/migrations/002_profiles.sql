-- Plan: profile tables. companion_profile holds the configuration of the
-- companion itself for the instance (about the AI); supported_person_profile
-- holds the durable record of the supported person (about the human);
-- circle_contacts links the supported person to their authorized circle.
--
-- The master ships an example shape only — config/companion.example.json.
-- Real per-instance values are created during Setup Mode in the copied
-- instance and stored here. No client data is ever committed to the master.

-- Configuration of the companion for this instance. One row per pilot.
CREATE TABLE companion_profile (
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

-- Durable structured record of the supported person. One row per pilot,
-- linked to the 'senior' user.
CREATE TABLE supported_person_profile (
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

-- Links the supported person to a member of their authorized circle.
-- permission_scope records which visibility levels that contact may see;
-- it defaults to none (default-deny).
CREATE TABLE circle_contacts (
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

-- Rollback:
-- DROP TABLE IF EXISTS circle_contacts;
-- DROP TABLE IF EXISTS supported_person_profile;
-- DROP TABLE IF EXISTS companion_profile;
