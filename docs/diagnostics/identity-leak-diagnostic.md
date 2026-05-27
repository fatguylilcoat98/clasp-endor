# Identity-leak diagnostic

Read-only SQL queries to compare two Supabase Auth accounts and determine whether they resolve to distinct `public.users` rows. Paste each fenced block (or the whole script) into the Supabase SQL editor or run via `psql`.

**Read-only.** Does NOT modify any rows.

## Usage

1. Edit the two `\set` lines at the top with the two emails under investigation.
2. Run section 1 through 6 in order. Each block returns its own result set.

## Output policy

- Sections 1, 2, 3, 5 return metadata only (ids, counts, scopes) — safe to share.
- Section 4 and section 6 return memory `content` prefixes — **do not paste those rows in public channels**; they contain stored phrasing.

## Goal

Prove which of these is happening:

- **A.** Both users separately stored sushi.
- **B.** Both users resolve to the same `public.users.id`.
- **C.** Session binding wrong (`auth_user_id` mismatch).
- **D.** Retrieval bypassing owner isolation (a memory row whose `owning_user_id` matches neither `public.users.id` is surfacing).

## The diagnostic

```sql
\set email_a '\'stangman_98@yahoo.com\''
\set email_b '\'stangman9898@gmail.com\''
```

### 1. Resolve `auth.users.id` for each email

Supabase Auth stores its users in the `auth` schema. If either lookup returns 0 rows, that email never finished Supabase signup. If BOTH lookups return the SAME `id`, Supabase has merged the accounts — that's the source of B at the auth layer.

```sql
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
```

### 2. Resolve `public.users` rows by `auth_user_id`

For each `auth.users.id` above, find the matching `public.users` row. If two distinct `auth_user_id` values map to the SAME `public.users.id`, that's identity collapse at the resolver layer — the `src/web/identity.js#resolveOrProvision` bug.

```sql
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
```

### 3. `memory_store` row counts per account

Counts only — no content. Confirms each account has its own memory rows. If account A has 5 rows and account B has 0 but both see "sushi" in chat responses, hypothesis D becomes more likely.

```sql
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
```

### 4. `memory_store` rows mentioning "favorite food" or "sushi"

Shows the content prefix because the operator needs to see what each memory says to distinguish A (each user independently stored sushi) from C/D. **Handle this output carefully — it contains stored phrasing.**

```sql
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
```

### 5. `circle_contacts` touching either account

Would explain a family_shared leak (hypothesis D).

```sql
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
```

### 6. SANITY: `memory_store` rows mentioning "sushi" anywhere

If this returns rows whose `owning_user_id` does NOT match either of the two `public.users.id` values from section 2, AND those rows are reaching the two accounts, that's hypothesis D — retrieval is bypassing owner isolation. Should normally be empty or contain only rows from the two accounts.

```sql
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
```

## Decision tree

Apply to the result sets above:

- **Section 2 returns 1 row instead of 2** → identity collapse (B). The two emails resolved to the same `public.users.id`.
- **Section 2 returns 2 rows with distinct `public.users.id` values** AND **section 4 returns rows owned by EACH user** → both users independently stored sushi (A). Not a bug; the extractor at `src/memory/extractor.js:49` caught a "my favorite food is sushi" phrasing from each user's own messages.
- **Section 2 returns 2 distinct rows** AND **section 4 returns rows owned by ONE user only** → check section 5. If the other user is in the first user's circle with `'family_shared'` in `permission_scope.visibility_levels` AND the leaked row has `visibility_level='family_shared'`, that's the expected behavior (the substrate is doing what `circle_contacts` asks of it).
- **Section 6 returns rows whose `owning_user_id` matches neither account** → those rows are coming from somewhere else. Investigate who their owner is via the LEFT JOIN columns.

Combine with the `/api/_debug/identity` endpoint output (server-side view) — same investigation, two angles.
