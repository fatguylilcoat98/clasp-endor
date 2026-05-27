-- Identity-leak diagnostic — compares two Supabase Auth accounts to
-- determine whether they resolve to distinct public.users rows and
-- to identify any memory_store rows that might be the source of
-- cross-account contamination.
--
-- READ-ONLY. Safe to run in the Supabase SQL editor or psql against
-- the project's Postgres. Does NOT modify any rows.
--
-- Usage:
--   1. Edit the two psql variables below to the two emails under
--      investigation.
--   2. Run the whole script in the Supabase SQL editor. Each numbered
--      block returns its own result set.
--
-- Output policy:
--   - Section 1 returns auth.users.id values (Supabase auth UUIDs).
--     These are metadata, NOT secrets.
--   - Section 4 returns memory_store.content for rows matching the
--     "favorite food" or "sushi" patterns. Do NOT paste those rows
--     in public channels — they contain the actual stored phrasing.
--   - Sections 2, 3, 5 are metadata-only (ids, counts, scopes).
--
-- Goal: prove which of these is happening:
--   A) Both users separately stored sushi
--   B) Both users resolve to the same public.users.id
--   C) Session binding is wrong (auth_user_id mismatch)
--   D) Retrieval is bypassing owner isolation (a memory row whose
--      owning_user_id matches NEITHER public.users.id is surfacing).

\set email_a '\'stangman_98@yahoo.com\''
\set email_b '\'stangman9898@gmail.com\''

-- ---------------------------------------------------------------------
-- 1. Resolve auth.users.id for each email.
-- ---------------------------------------------------------------------
-- Supabase Auth stores its users in the `auth` schema. If either
-- lookup returns 0 rows, that email never finished Supabase signup
-- (the password/email flow created no row). If BOTH lookups return
-- the SAME id, Supabase has merged the accounts — that's the source
-- of B (identity collapse at the auth layer, not the app layer).
SELECT
  '1. auth_user'                AS subject,
  email,
  id                            AS auth_user_id,
  email_confirmed_at,
  created_at,
  last_sign_in_at
FROM auth.users
WHERE email IN (:email_a, :email_b)
ORDER BY email;

-- ---------------------------------------------------------------------
-- 2. Resolve public.users rows by auth_user_id (the Path-2 link
--    added in db/migrations/017).
-- ---------------------------------------------------------------------
-- For each auth.users.id above, find the matching public.users row.
-- If TWO distinct auth_user_id values map to the SAME public.users.id,
-- that's identity collapse at the resolver layer — the
-- src/web/identity.js#resolveOrProvision bug.
-- If an auth.users.id has NO matching public.users row, the resolver
-- never provisioned the row (likely failure mode: ENETUNREACH on the
-- LYLO_SETUP_DATABASE_URL connection, see PR #10).
SELECT
  '2. public_user'              AS subject,
  pu.id                         AS public_user_id,
  pu.auth_user_id,
  pu.pilot_instance_id,
  pu.username,
  pu.role,
  pu.created_at
FROM public.users pu
WHERE pu.auth_user_id IN (
  SELECT id FROM auth.users WHERE email IN (:email_a, :email_b)
)
ORDER BY pu.created_at;

-- ---------------------------------------------------------------------
-- 3. memory_store rows owned by either public.users row,
--    aggregated by visibility tier and status.
-- ---------------------------------------------------------------------
-- COUNTS only — no content. Confirms each account has its own
-- memory rows. If account A has 5 rows and account B has 0 but
-- both see "sushi" in chat responses, hypothesis D (retrieval
-- bypass) becomes more likely.
SELECT
  '3. memory_count'             AS subject,
  owning_user_id,
  visibility_level,
  memory_status,
  active,
  COUNT(*)                      AS row_count
FROM public.memory_store
WHERE owning_user_id IN (
  SELECT pu.id FROM public.users pu
  WHERE pu.auth_user_id IN (
    SELECT id FROM auth.users WHERE email IN (:email_a, :email_b)
  )
)
GROUP BY owning_user_id, visibility_level, memory_status, active
ORDER BY owning_user_id, visibility_level, memory_status, active;

-- ---------------------------------------------------------------------
-- 4. memory_store rows mentioning "favorite food" or "sushi",
--    for the two accounts.
-- ---------------------------------------------------------------------
-- SHOWS the content prefix because the operator needs to see
-- exactly what each memory says to distinguish hypothesis A
-- (each user independently stored sushi) from C/D (something
-- else surfacing sushi).
-- HANDLE THIS OUTPUT CAREFULLY — it contains stored phrasing.
SELECT
  '4. sushi_memory'             AS subject,
  owning_user_id,
  id                            AS memory_id,
  visibility_level,
  memory_status,
  active,
  LEFT(content, 200)            AS content_first_200,
  LENGTH(content)               AS content_length,
  created_at
FROM public.memory_store
WHERE owning_user_id IN (
  SELECT pu.id FROM public.users pu
  WHERE pu.auth_user_id IN (
    SELECT id FROM auth.users WHERE email IN (:email_a, :email_b)
  )
)
AND (
  content ILIKE '%favorite food%'
  OR content ILIKE '%sushi%'
)
ORDER BY owning_user_id, created_at DESC;

-- ---------------------------------------------------------------------
-- 5. circle_contacts: see whether either account is in the other's
--    circle (would explain a family_shared leak — hypothesis D).
-- ---------------------------------------------------------------------
SELECT
  '5. circle'                   AS subject,
  cc.senior_user_id,
  cc.contact_user_id,
  cc.permission_scope,
  cc.created_at
FROM public.circle_contacts cc
WHERE cc.senior_user_id IN (
  SELECT pu.id FROM public.users pu
  WHERE pu.auth_user_id IN (
    SELECT id FROM auth.users WHERE email IN (:email_a, :email_b)
  )
)
   OR cc.contact_user_id IN (
  SELECT pu.id FROM public.users pu
  WHERE pu.auth_user_id IN (
    SELECT id FROM auth.users WHERE email IN (:email_a, :email_b)
  )
)
ORDER BY cc.created_at;

-- ---------------------------------------------------------------------
-- 6. SANITY: memory_store rows mentioning "sushi" anywhere in the
--    project, regardless of owning_user_id.
-- ---------------------------------------------------------------------
-- If this returns rows whose owning_user_id does NOT match either of
-- the two public.users.id values from section 2, AND those rows are
-- somehow reaching the two accounts, that's hypothesis D — retrieval
-- is bypassing owner isolation. Should normally be empty or contain
-- only rows from the two accounts under investigation.
SELECT
  '6. sushi_anywhere'           AS subject,
  ms.owning_user_id,
  ms.id                         AS memory_id,
  ms.visibility_level,
  ms.memory_status,
  ms.active,
  LENGTH(ms.content)            AS content_length,
  pu.username                   AS owner_username,
  pu.role                       AS owner_role
FROM public.memory_store ms
LEFT JOIN public.users pu ON pu.id = ms.owning_user_id
WHERE ms.content ILIKE '%sushi%'
ORDER BY ms.created_at DESC
LIMIT 50;

-- ---------------------------------------------------------------------
-- Decision tree (apply to the result sets above):
-- ---------------------------------------------------------------------
--   - Section 2 returns 1 row instead of 2 → identity collapse (B).
--     The two emails resolved to the same public.users.id.
--   - Section 2 returns 2 rows with distinct public.users.id values
--     AND section 4 returns >= 1 row owned by EACH user → both users
--     independently stored sushi (A). Not a bug; the extractor at
--     src/memory/extractor.js:49 caught a "my favorite food is sushi"
--     phrasing from each user's own messages.
--   - Section 2 returns 2 distinct rows AND section 4 returns rows
--     owned by ONE user only → check section 5. If the other user is
--     in the first user's circle with 'family_shared' in
--     permission_scope.visibility_levels AND the leaked row has
--     visibility_level='family_shared', that's the expected behavior
--     (the substrate is doing what circle_contacts asks of it).
--   - Section 6 returns rows whose owning_user_id matches neither
--     account → those rows are coming from somewhere else. Investigate
--     who their owner is via the LEFT JOIN columns.
--
-- Combine with the /api/_debug/identity endpoint output (server-side
-- view) — same investigation, two angles.
