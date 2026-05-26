# Memory authority hierarchy

This document codifies how the memory layer ranks competing facts about a
supported person. The Daniel poisoned-memory incident (commit `9b2d199`)
made explicit that the substrate must rank memories by the *source of
authority*, not just by recency, and must hide superseded facts from
retrieval entirely.

This hierarchy is derived from existing columns on `memory_store` — no
schema change. The mapping is implemented in
`src/memory/repository.js#computeAuthority`, applied as both a SQL
`ORDER BY` and a JS post-annotation on every row returned from
`listVisibleMemories`.

## The ranks (highest → lowest)

| Rank | Authority         | How a memory becomes this | Notes |
|----:|--------------------|---------------------------|-------|
| 1 | `USER_CORRECTED`     | `content` starts with `CORRECTION:` or `RETRACTION:` | Stored by `src/memory/writer.js` when the extractor detects a user correction. Outranks every other source. |
| 2 | `USER_CONFIRMED`     | `memory_status = 'VERIFIED'` AND `provenance = 'USER_STATED'` | Promoted from working memory after the writer's high-confidence threshold (≥ 0.9). |
| 3 | `SYSTEM_SEEDED`      | `provenance = 'VERIFIED_FACT'` | Operator-set bootstrap facts. Rare. |
| 4 | `VERIFIED`           | `memory_status = 'VERIFIED'` (any other provenance) | Catch-all for verified-status rows that don't fit above. |
| 5 | `EXTRACTED`          | `memory_status = 'WORKING_ACTIVE'` AND `provenance = 'USER_STATED'` | Default state for newly-extracted user statements awaiting promotion. |
| 6 | `INFERRED`           | `provenance = 'AI_INFERRED'` | Model guess. Lowest non-superseded authority. |
| 7 | `LOW_CONFIDENCE`     | Fallthrough | Should not normally occur. Included for completeness. |
| — | `SUPERSEDED` (hidden) | `memory_status = 'SUPERSEDED'` OR `active = false` | **Excluded from retrieval entirely** by the `WHERE` clause in `listVisibleMemories`. Never participates in ranking. |

## Invariants

1. **`USER_CORRECTED` outranks `SYSTEM_SEEDED` and `INFERRED`.**
   If a seeded fact says "User's brother is Daniel" and the user says "I
   don't have a brother named Daniel", the correction wins in retrieval
   order *and* the seeded row is deactivated (via
   `writer.js#storeWorkingMemories` → `repository.js#deactivateMemory`).

2. **`SUPERSEDED` is never retrieved.**
   `listVisibleMemories`'s `WHERE active = true AND memory_status IN
   ('WORKING_ACTIVE', 'VERIFIED')` clause is the only retrieval path; it
   structurally excludes `SUPERSEDED` rows. The append-only
   `governance_audit_log` retains the `memory.updated` row that records
   the deactivation, so the operator can still see the history.

3. **Authority is derived, not stored.**
   No column on `memory_store` holds `authority_level`. It is computed
   from `content`, `provenance`, and `memory_status`. Adding a stored
   column would create a denormalization risk (the trigger from
   `db/migrations/015` would have to grow to protect it).

4. **Authority is inspectable.**
   Every row returned by `companionReader.readVisibleMemories` carries
   `row.authority_level`. The brain pipeline, the conversation prompt
   builder, the audit panel, and any future admin retrieval-inspection
   surface can read it without re-deriving.

## Retrieval ranking is intentional

The query orders by authority bucket first, `created_at DESC` second.
This means:

- Two `USER_CORRECTED` facts: the more recent one appears first.
- A `USER_CONFIRMED` fact from last week beats a brand-new `EXTRACTED`
  fact from this turn, because confirmation is stronger than mere
  extraction.
- An `INFERRED` fact never beats anything user-stated, no matter how
  recent.

This is the opposite of "newest wins". The Daniel incident showed why
newest-wins is dangerous: a poisoned memory at seed time would beat any
later correction if recency alone decided.

## What this does NOT do

- It does not introduce a new `EVENT_TYPES` value. The `memory.updated`
  event (added in PR #3 for the correction system) is still the only
  audit event around supersession.
- It does not introduce a new column. The `authority_level` field on
  returned rows is virtual.
- It does not change the writer's confidence threshold. Promotion to
  `USER_CONFIRMED` still requires `confidence >= 0.9` per
  `writer.js#storeWorkingMemories`.
- It does not enable any new mutation path. UPDATE on `memory_store` is
  still restricted to `{memory_status, active, updated_at}` by the
  memory-boundary CI guard, and the db/migrations/015 trigger enforces
  the same at the DB layer.

## Future: when to add a stored column

If the rules above ever stop fitting the derived columns (e.g. an
authority level that can't be inferred from `provenance` + `memory_status`
+ content prefix), the right move is:

1. Open a paired migration (NNN_memory_authority.sql) that adds
   `authority_level TEXT NOT NULL DEFAULT 'EXTRACTED'` with a CHECK
   constraint.
2. Extend the immutability trigger from `db/migrations/015` to protect
   it from in-place mutation.
3. Extend the memory-boundary CI guard's `UPDATE_ALLOWED_COLUMNS` to
   permit deliberate transitions (if any).
4. Update this document.

Until then, derivation is correct and avoids substrate expansion.
