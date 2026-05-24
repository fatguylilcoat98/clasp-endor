-- Fixtures for the synthetic RLS / privacy contract suite.
--
-- Two pilots so cross-pilot isolation can be verified. All identifiers
-- are obviously fictional. The fixtures must be seeded BEFORE RLS is
-- enabled (or under a BYPASSRLS role / the superuser); the runner
-- applies synthetic-schema.sql, then fixtures.sql, then policies.sql.

-- Pilot A
INSERT INTO pilot_instances (id, org_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Pilot A Org');

INSERT INTO users (id, pilot_instance_id, username, role) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'senior-A',     'senior'),
  ('aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'family-A',     'family'),
  ('aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'caregiver-A',  'caregiver'),
  ('aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin-A',      'admin');

INSERT INTO companion_profile (pilot_instance_id, companion_name, persona) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Aria', '{"tone":"warm"}'::jsonb);

INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'Person A');

INSERT INTO setup_state (pilot_instance_id, step_key, status, completed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'provisioning_complete', 'complete', now());

-- family-A: in circle with family_shared permission.
INSERT INTO circle_contacts (pilot_instance_id, senior_user_id, contact_user_id, permission_scope) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa',
   '{"visibility_levels":["family_shared"]}'::jsonb);

-- caregiver-A: in circle but NO family_shared permission.
INSERT INTO circle_contacts (pilot_instance_id, senior_user_id, contact_user_id, permission_scope) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa',
   '{"visibility_levels":[]}'::jsonb);

-- Senior A's vault + sessions.
INSERT INTO memory_vaults (id, pilot_instance_id, user_id, pin_hash, pin_salt) VALUES
  ('aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'fake-hash', 'fake-salt');

-- Open session (unexpired, not revoked).
INSERT INTO memory_vault_sessions (id, pilot_instance_id, vault_id, user_id, expires_at) VALUES
  ('aaaaaaaa-bbbb-1111-1111-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   now() + interval '1 hour');

-- Revoked session — must not unlock anything.
INSERT INTO memory_vault_sessions (id, pilot_instance_id, vault_id, user_id, expires_at, revoked_at) VALUES
  ('aaaaaaaa-bbbb-2222-1111-cccccccccccc',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   now() + interval '1 hour',
   now());

-- Senior A's memories: one of each visibility level + one inadmissible.
INSERT INTO memory_store (id, pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state, vault_id) VALUES
  ('aaaaaaaa-cccc-1111-1111-100000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'private content A',
   'USER_STATED',
   'private',
   'admissible',
   NULL),
  ('aaaaaaaa-cccc-1111-1111-100000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'family-shared content A',
   'USER_STATED',
   'family_shared',
   'admissible',
   NULL),
  ('aaaaaaaa-cccc-1111-1111-100000000003',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'password-locked content A',
   'USER_STATED',
   'password_locked',
   'admissible',
   'aaaaaaaa-aaaa-1111-1111-bbbbbbbbbbbb'),
  ('aaaaaaaa-cccc-1111-1111-100000000004',
   '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'inadmissible family-shared content A',
   'AI_INFERRED',
   'family_shared',
   'inadmissible',
   NULL);

INSERT INTO governance_audit_log (pilot_instance_id, target_user_id, event_type, actor_user_id, actor_role, outcome) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'memory.created',
   'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
   'senior',
   'allowed');

-- Pilot B (separate tenant — for cross-pilot isolation tests).
INSERT INTO pilot_instances (id, org_name) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Pilot B Org');

INSERT INTO users (id, pilot_instance_id, username, role) VALUES
  ('bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'senior-B', 'senior'),
  ('bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'admin-B',  'admin');

INSERT INTO companion_profile (pilot_instance_id, companion_name, persona) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Bram', '{"tone":"steady"}'::jsonb);

INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'Person B');

INSERT INTO memory_store (id, pilot_instance_id, owning_user_id, content, provenance, visibility_level, admissibility_state) VALUES
  ('bbbbbbbb-cccc-2222-2222-200000000001',
   '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'private content B',
   'USER_STATED',
   'private',
   'admissible');

INSERT INTO governance_audit_log (pilot_instance_id, target_user_id, event_type, actor_user_id, actor_role, outcome) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'memory.created',
   'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb',
   'senior',
   'allowed');
