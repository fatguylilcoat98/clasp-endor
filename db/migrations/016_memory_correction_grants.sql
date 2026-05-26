-- Grant lylo_app the narrowly-scoped UPDATE it needs to drive memory
-- correction / supersession (commit 8637637 onward).
--
-- Why this exists:
--   - db/migrations/015 added the memory_status column and the
--     immutability trigger that protects id, pilot_instance_id,
--     owning_user_id, content, provenance, created_at.
--   - src/memory/repository.js#deactivateMemory and
--     src/memory/repository.js#promoteMemoryToVerified issue
--     scoped UPDATEs on memory_store that only touch the columns
--     {active, memory_status, updated_at}.
--   - lylo_app had no UPDATE grant prior to this migration, so the
--     correction system was failing silently in production
--     (UPDATE → permission denied → MemoryRepositoryError → swallowed
--     by writer.js#storeWorkingMemories outer try/catch).
--
-- Defense in depth (none of these is weakened by this grant):
--   - The db/migrations/015 trigger STILL blocks UPDATEs that touch
--     id, pilot_instance_id, owning_user_id, content, provenance,
--     created_at — even attempted via this grant.
--   - The memory-boundary CI guard
--     (scripts/ci/check-memory-boundary.js) STILL restricts UPDATE
--     statements to src/memory/repository.js only, on memory_store
--     only, and only when the SET clause names {memory_status,
--     active, updated_at}.
--   - RLS on memory_store STILL applies (lylo_app has no BYPASSRLS).
--
-- This migration MUST be applied to every existing deployment for
-- correction/supersession to function. MASTER_MIGRATION.sql is
-- updated in the same PR.

GRANT UPDATE (active, memory_status, updated_at) ON memory_store TO lylo_app;

-- RLS policy paired with the grant. memory_store has SELECT + INSERT
-- policies from db/migrations/007 but no UPDATE policy — RLS is
-- default-deny when enabled and no matching policy exists, so the
-- grant above alone is insufficient. Without this policy the UPDATE
-- returns zero rows ("memory not found or already deactivated") and
-- the correction system silently fails.
--
-- USING narrows which rows the user may update (their own memories
-- within their own pilot).
-- WITH CHECK constrains the post-update row state — same predicate,
-- because the immutability trigger from db/migrations/015 already
-- prevents the user from changing the columns that would otherwise
-- need WITH CHECK protection (pilot_instance_id, owning_user_id,
-- content, provenance, etc.).
DROP POLICY IF EXISTS memory_store_owner_update ON memory_store;
CREATE POLICY memory_store_owner_update ON memory_store FOR UPDATE
  USING (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    pilot_instance_id = NULLIF(current_setting('app.pilot_instance_id', true), '')::uuid
    AND owning_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Rollback (revoke + drop policy; correction system will silently break):
-- DROP POLICY IF EXISTS memory_store_owner_update ON memory_store;
-- REVOKE UPDATE (active, memory_status, updated_at) ON memory_store FROM lylo_app;
