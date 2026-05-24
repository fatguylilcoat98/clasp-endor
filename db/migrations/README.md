# Database migrations

Migrations for the Lylo Companion platform live here, one file per
migration, numbered sequentially (`NNN_short_description.sql`).

## Status (GM-24)

Migrations `001`–`009` are in place: the GM-3 baseline schema, the
GM-15 RLS / privacy policies, the GM-23 review-queue substrate,
and the GM-24 review-decision substrate. The master starts a
**clean** migration chain — no historical or archived SQL is
carried over from any reference system.

| Migration | Establishes |
|---|---|
| `001_baseline.sql` | `pilot_instances` (tenancy root), `users`, one-senior-per-pilot. |
| `002_profiles.sql` | `companion_profile`, `supported_person_profile`, `circle_contacts`. |
| `003_vaults.sql` | `memory_vaults`, `memory_vault_sessions`. |
| `004_memory_store.sql` | `memory_store` with provenance / visibility / admissibility columns + an immutability trigger. |
| `005_audit_log.sql` | `governance_audit_log` + an append-only trigger. |
| `006_setup_state.sql` | `setup_state`. |
| `007_rls_policies.sql` | The four `lylo_*` DB roles, schema USAGE + per-table GRANTs, `ENABLE ROW LEVEL SECURITY` on the ten client-scoped tables, and the validated RLS policies. See `docs/governance/rls-privacy-contract.md`. RLS is engaged in production as of GM-16. |
| `008_review_queue.sql` | `governance_review_queue` — the GM-23 durable substrate for `requires_review` Decisions. CHECK constraints mirror GM-21 INTENT_TYPES + REASONS; `status` is locked to `'pending_review'`; a BEFORE-UPDATE-OR-DELETE trigger enforces append-only; three RLS policies (insert_own / proposer SELECT / admin SELECT) gate access; INSERT grants only to `lylo_app`, SELECT to `lylo_app` and `lylo_admin`, no grants to `lylo_runtime` or `lylo_setup`. See `docs/governance/review-queue-runtime-boundary.md`. |
| `009_review_decisions.sql` | `governance_review_decisions` — the GM-24 durable substrate for the human admin's review outcome (`approved` / `rejected`) against a pending queue item. Also adds a `UNIQUE (pilot_instance_id, id)` constraint to `governance_review_queue` so the new composite FK can point at it. `reviewer_role` CHECK-locked to `'admin'`; `review_outcome` CHECK in `('approved','rejected')`; `review_reason` CHECK in a 5-value vocabulary; `UNIQUE(review_queue_id)` enforces one review per queue item; BEFORE-UPDATE-OR-DELETE trigger enforces append-only; BEFORE-INSERT trigger refuses if reviewer is the original proposer (self-review prevention); three RLS policies (insert_admin / admin SELECT / proposer SELECT). Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`, none to `lylo_runtime`/`lylo_setup`. **Recording a review is NOT execution. Approval is NOT authorization.** See `docs/governance/review-decision-runtime-boundary.md`. |

### Deferred — not in GM-24

- **Admissibility lifecycle.** GM-3 ships the `admissibility_state`
  column and the `superseded_by` link only; the proposed/pending/verified
  flow, dispute handling, and the authority-validation workflow
  remain deferred.
- **Execution-authorization.** GM-24 records the human admin's
  review outcome — but a recorded approval is **not** authorization
  to act. Future execution-authorization substrates (GM-25+) would
  need separately gated decisions, separate immutable artifacts,
  and explicit consumer surfaces.
- **Consumer of `governance_review_decisions`.** No production
  code reads recorded review outcomes for any operational purpose
  in GM-24. A future "act on approved item" capability is its own
  decision gate with its own boundary guard + adversarial review.
- Derived-memory, outbound-message, and compose-authorization
  tables.

## Rules

- One file per migration, numbered `NNN_*.sql`.
- Additive-first; destructive changes require explicit owner sign-off
  recorded in the migration header.
- Each migration opens with a `-- Plan:` comment and ends with its
  rollback SQL, commented, after the body.
- The master ships schema only — never client data. A copied instance
  runs these migrations against its own empty database.
