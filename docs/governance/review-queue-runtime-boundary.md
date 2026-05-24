# Review-Queue Runtime Boundary

**Applies to:** the review-queue substrate (`src/review/` library +
`src/actors/review-queue-actor.js` actor + the
`governance_review_queue` table created by
`db/migrations/008_review_queue.sql`). Introduced in GM-23 — the
first persistence expansion since the process lock.
**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, a read API, a new column, or relaxing
the CHECK constraints requires paired updates to this document,
the migration chain, the rls-contract synthetic suite, and the
GM-22 adversarial snapshot tests.
**Depends on:** `source-of-truth-memory-policy.md`,
`governance-runtime-boundary.md` (the classifier + Decision shape
the actor consumes), `actor-runtime-boundary.md` (the actor
contract), `rls-privacy-contract.md` (the engaged RLS policies),
`memory-runtime-boundary.md` (orthogonal — the review queue does
not write memory).

## Purpose

GM-22 closed the "you cannot act without a Decision" gap. But the
GM-21 classifier returns `requires_review` for
`memory.candidate.create` AI_INFERRED and USER_STATED — and until
GM-23, those Decisions had nowhere to go. The review-queue actor's
`abstained` outcome surfaced the classification but left no
durable artifact.

GM-23 introduces the smallest possible persistence substrate
proving:

- a `requires_review` Decision can be **durably staged** for later
  human / operator review,
- the staged record is **immutable** and **append-only**,
- staging requires a **valid `requires_review` Decision** —
  forged, mutated, admissible, or inadmissible Decisions are all
  rejected,
- staging **never executes**, never auto-admits, never auto-
  promotes, never schedules background work, never notifies
  external systems, and never widens execution authority.

The queue is **inert**. It records. Nothing in GM-23 reads the
queue for action, transitions row state, dequeues, or notifies a
reviewer. A future human-review surface (a separate decision
gate) will consume it.

This is durable **governance staging** — not workflow automation,
not agent orchestration, not a task system.

## 1. Module placement

```
src/
  runtime/      — config loader (unchanged)
  db/           — pg pool (unchanged)
  memory/       — memory DB lib (unchanged)
  companion/    — read-only consumer (unchanged)
  conversation/ — single-shot model runtime (unchanged)
  governance/   — classifier + Decision shape (unchanged)
  review/       — NEW (GM-23). Review-queue DB-access library.
                  Structurally parallel to src/memory/: own
                  client.js (opaque ReviewPoolHandle pattern),
                  transaction.js (withReviewContext), repository.js
                  (stageReviewItem — single function, single
                  INSERT), errors.js (ReviewRepositoryError), log.js,
                  index.js. Connects as lylo_app via
                  LYLO_APP_DATABASE_URL (same LOGIN role as the
                  memory module; separate pool handle). Guarded by
                  NEW check-review-boundary.js. Imports nothing from
                  any other src/ layer.
  actors/       — Adds a SECOND actor: review-queue-actor.js. Imports
                  `../governance` (entry only — for the Decision
                  contract) AND `../review` (entry only — for
                  withReviewContext + stageReviewItem). The existing
                  check-actors-boundary.js is extended to permit
                  `../review` / `../review/index` as the third public
                  entry the actor layer may import.
```

The review module is a **leaf** with respect to other `src/` layers
(it imports nothing from `../memory`, `../companion`,
`../conversation`, `../governance`, `../actors`, `../runtime`,
`../db`, `../setup`). The actor in `src/actors/` is the only
production caller.

## 2. Schema (db/migrations/008_review_queue.sql)

```sql
CREATE TABLE governance_review_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_instance_id    UUID NOT NULL REFERENCES pilot_instances(id),
  decision_intent_type TEXT NOT NULL  CHECK (decision_intent_type IN (... 8 INTENT_TYPES values ...)),
  decision_reason      TEXT NOT NULL  CHECK (decision_reason IN (... 11 REASONS values ...)),
  decision_policy_ref  TEXT NOT NULL,
  proposer_user_id     UUID NOT NULL,
  proposer_role        TEXT NOT NULL  CHECK (proposer_role IN ('senior','family','caregiver','admin','system')),
  payload_summary      JSONB,
  evidence_summary     JSONB,
  status               TEXT NOT NULL DEFAULT 'pending_review'
                       CHECK (status = 'pending_review'),   -- LOCKED single value
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (pilot_instance_id, proposer_user_id)
    REFERENCES users (pilot_instance_id, id)
);
```

Three layers of "cannot mutate":

1. **Append-only trigger** — `BEFORE UPDATE OR DELETE → RAISE`
   fires for every role including superuser. Mirrors
   `governance_audit_log`.
2. **GRANT layer** — `lylo_app` has only `SELECT` + `INSERT`; no
   `UPDATE` or `DELETE` grants. `lylo_admin` has only `SELECT`.
   `lylo_runtime` and `lylo_setup` have no grants at all.
3. **CHECK constraint on `status`** — even if a future GM grants
   `UPDATE`, the constraint refuses any value other than
   `'pending_review'`. Status transitions are deliberately not
   modelled in GM-23.

The CHECK lists for `decision_intent_type` and `decision_reason`
mirror the GM-21 `INTENT_TYPES` and `REASONS` vocabularies
verbatim. Any future widening of those vocabularies requires a
paired migration that expands these CHECK constraints in lockstep
— see §11 change control.

## 3. RLS policies

| Policy | Scope | Effect |
|---|---|---|
| `review_queue_insert_own` | `INSERT WITH CHECK` | `pilot_instance_id = app.pilot_instance_id AND proposer_user_id = app.user_id`. Tenant-scope + no impersonation. |
| `review_queue_proposer` | `SELECT USING` | Proposer sees own rows in pilot. |
| `review_queue_admin` | `SELECT USING` | Admin in pilot sees all rows. |

**Visibility narrowed to proposer + admin (OQ-23.7).** Family,
caregiver, system, and runtime roles see nothing on
`governance_review_queue`. The review-queue holds proposed memory
content; broader visibility would weaken the privacy contract.

## 4. Public API surface (GM-23)

`src/review/`:

| Export | Purpose |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | Returns an opaque `ReviewPoolHandle` (mirrors the GM-18 `MemoryPoolHandle` pattern). |
| `closeReviewQueuePool(handle)` | Closes the underlying pool. |
| `withReviewContext(handle, {pilotInstanceId, userId, userRole}, fn)` | Transaction-discipline helper. BEGIN + 3× set_config(app.*) + fn(ctx) + COMMIT/ROLLBACK. `ctx` exposes only `stageReviewItem`. |
| `ReviewRepositoryError` | Sanitized pg-error wrapper. Carries `name`, `error_class`, fixed `message`; never `detail`/`where`/`routine`/`parameters`. |

`src/actors/`:

| Export | Purpose |
|---|---|
| `createReviewQueueActor({reviewQueuePool, log?})` | Factory. Returns a frozen actor with one method: `execute(decision, params)`. |
| `OUTCOMES.STAGED` | New value (`'staged'`) added to the shared `OUTCOMES` enum alongside GM-22's `EXECUTED` / `ABSTAINED` / `REJECTED`. |

**No read API** in GM-23 per OQ-23.11. `src/review/` exposes no
`listReviewQueue` or `getReviewItem` function. The SELECT policies
exist so a future human-review surface (separate decision gate)
can be built without schema changes — but no consumer code is
added in GM-23.

## 5. Decision-verification chain (six layers)

The review-queue actor inherits the GM-22 five-layer chain and
adds one more:

| # | Check | Catches |
|---|---|---|
| 1 | `decision instanceof Decision` | Plain objects / primitives. |
| 2 | `isValidDecision(decision)` (WeakSet membership) | Prototype-tampered forgeries. |
| 3 | `Object.isFrozen(decision)` | Mutation attempts. |
| 4 | `decision.intentType ∈ INTENT_TYPES` | Unknown intent types. (Unlike the response-delivery actor's single-intent lock, the review-queue actor accepts any value in INTENT_TYPES — any intent type can in principle be classified `requires_review`.) |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` non-empty | Vocabulary drift. |
| **6** | **`decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW`** | **Admissible and inadmissible Decisions, both of which belong elsewhere.** |

All six fail-closed via **throw** (programmer error). The
underlying review pool is not consulted on any failure path.

On a verified `requires_review` Decision, the actor:

1. Calls `withReviewContext(pool, {pilotInstanceId, userId, userRole}, ctx => ctx.stageReviewItem(...))`.
2. The `stageReviewItem` repository function issues **one INSERT**
   into `governance_review_queue` with `RETURNING id, created_at`.
3. Returns a frozen outcome `{outcome: 'staged', decision,
   queueEntryId, createdAt}`.

## 6. The actor's handoff to the review module

```
caller (test or future GM)
  ├─ has intent { type, payload, evidence }
  ├─ classifies → Decision
  ├─ if Decision.decision === 'admissible' → response-delivery actor (GM-22)
  ├─ if Decision.decision === 'requires_review' → review-queue actor (GM-23, NEW)
  └─ if Decision.decision === 'inadmissible' → no actor; caller logs and abstains

review-queue actor accepts:
  execute(decision, {
    pilotInstanceId, userId, userRole,    // session context (server-resolved)
    payloadSummary,                        // JSONB — what was proposed
    evidenceSummary                        // JSONB — what triggered the proposal
  })

actor verifies decision (6-layer chain) →
  delegates to src/review/ withReviewContext:
    BEGIN; set_config × 3; INSERT into governance_review_queue; COMMIT
  returns { outcome: 'staged', decision, queueEntryId, createdAt }
```

The `proposer_user_id` column is populated from `sessionCtx.userId`
inside `stageReviewItem` — NEVER from the input parameters. Combined
with the RLS `WITH CHECK` policy, this means a malicious caller
cannot stage a review item on behalf of another user.

## 7. Boundary guard

`scripts/ci/check-review-boundary.js` scans `src/review/` only:

| Rule | Why |
|---|---|
| Banned write/DDL SQL: `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` (INSERT permitted but allowlisted) | Append-only persistence. |
| `FROM`/`JOIN` allowlist: `governance_review_queue`, `users`, `pilot_instances` | The module sees only its own table + identity/pilot tables. |
| `INSERT INTO` allowlist: `governance_review_queue` only | The only write target. |
| `pg` import scoped to `src/review/client.js` | DB driver bounded. |
| Forbidden: every model SDK (incl. `@anthropic-ai/sdk`); HTTP frameworks; `child_process`/`worker_threads`/`cluster`; `setInterval`/`setImmediate`/`cron`/`schedule`; every `fs.write*` API; streaming + tool-calling identifiers; `insertPrivateMemory` | No execution surface. |
| Cross-layer imports of any `src/` peer | The module is a leaf. |

The existing `check-actors-boundary.js` is extended to permit
`../review` and `../review/index` as the third public-entry import
the actor layer may use.

## 8. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| Cannot stage without a Decision | Actor signature requires Decision; layer 1 throws on non-Decision input. |
| Cannot stage anything other than `requires_review` | Layer 6 (new) throws. |
| Cannot stage a forged/tampered Decision | Inherited GM-22 chain (instanceof + WeakSet + frozen + structural revalidation). |
| Cannot impersonate the proposer | `WITH CHECK` policy: `proposer_user_id = app.user_id`. Plus: `stageReviewItem` always populates `proposer_user_id` from `sessionCtx.userId`, not from caller input. |
| Cannot stage cross-pilot | `WITH CHECK` policy: `pilot_instance_id = app.pilot_instance_id`. |
| Cannot mutate a queue entry | BEFORE-UPDATE-OR-DELETE trigger + no `UPDATE`/`DELETE` grant + CHECK on status. |
| Cannot transition status | CHECK constraint `status = 'pending_review'`. |
| Cannot dequeue / auto-act / auto-promote | No dequeue API in `src/review/`. No actor consumes the queue in GM-23. |
| Cannot notify external systems | Boundary guard bans HTTP frameworks, model SDKs, fs writes, scheduling. |
| Cannot schedule background polling | Same. |
| Cannot bypass via raw DB access | Boundary guard scopes `pg` import to `src/review/client.js`. `lylo_runtime` has no grant. Even an attacker with the `lylo_app` LOGIN role's password is bound by WITH CHECK + tenant-scope + CHECK constraints. |
| Cannot widen EVENT_TYPES | GM-22 adversarial snapshot C1 + GM-23 snapshot E10 both still assert the GM-18 lock holds. |
| Cannot use the queue to elevate a memory candidate into a real memory_store row | The queue holds the proposal as JSONB; it has no machinery to promote it. Memory creation still requires going through `memory.candidate.create` admissibility — currently `requires_review` for AI_INFERRED/USER_STATED and `inadmissible` for VERIFIED_FACT. The chain is structurally non-recursive. |
| Cannot mount from boot | `src/runtime/boot.js` does not import `src/review/` or the new actor. Library-only posture continues. |

## 9. Adversarial review additions

`tests/governance/adversarial.test.js` is extended with an
**E-series**:

| # | Probe | Asserted outcome |
|---|---|---|
| E1 | Pass a duck-typed Decision to the review-queue actor | throws — `instanceof` fails |
| E2 | Prototype-tampered fake | throws — WeakSet membership rejects |
| E3 | Real admissible Decision (response.deliver) | throws — only `requires_review` can be staged |
| E4 | Real inadmissible Decision | throws — same |
| E5 | Real `requires_review` Decision with non-UUID pilotInstanceId | throws BEFORE `pool.connect` |
| E6 | Sentinel content in `payloadSummary` and `evidenceSummary` | sentinels never appear in captured logs |
| E10 | Memory `EVENT_TYPES` snapshot | unchanged — no new event types added |

Plus integration scenarios in
`tests/integration/review-queue.test.js`:

| # | Probe | Asserted outcome |
|---|---|---|
| Happy path | Stage a row; read back as proposer | one row inserted; status=`pending_review` |
| Visibility — admin | Admin in pilot SELECTs | sees rows |
| Visibility — family | Family SELECTs | sees nothing |
| Cross-pilot INSERT | Senior-A tries to insert with `pilot_instance_id = pilot_B` | RLS / FK violation |
| Impersonation INSERT | Family tries to insert with `proposer_user_id = senior_A` | RLS WITH CHECK violation |
| CHECK on `status` | Insert with `status = 'reviewed'` | constraint violation |
| CHECK on intent_type | Insert with `decision_intent_type = 'agent.spawn'` | constraint violation |
| Append-only — UPDATE | Superuser attempts UPDATE | trigger raises |
| Append-only — DELETE | Superuser attempts DELETE | trigger raises |
| GRANT layer — lylo_app UPDATE | lylo_app attempts UPDATE | permission denied |
| GRANT layer — lylo_app DELETE | lylo_app attempts DELETE | permission denied |
| GRANT layer — lylo_runtime SELECT | lylo_runtime attempts SELECT | permission denied |

## 10. Logging hygiene

`src/actors/review-queue-actor.js` and `src/review/log.js` both
emit at most metadata events:

```
{"ts":"…","level":"info","event":"actor.review_queue.staged",
 "pid":…,"intent_type":"memory.candidate.create",
 "decision":"requires_review","reason":"ai_inferred_requires_review",
 "queue_entry_id":"<uuid>","proposer_user_id":"<uuid>",
 "actor_role":"senior"}
```

Never `payload_summary`, never `evidence_summary`, never the
original user message that triggered the proposal. The sentinel-
scan tests (actor unit test + adversarial E6) plant secrets in
both JSONB fields and assert neither appears in any captured log
line.

## 11. Change control

This is a high-friction change point. Any of the following
requires a reviewed change to **this document** AND one or more
paired artifacts in the same PR:

| Change | Paired updates required |
|---|---|
| Add a status value | `db/migrations/<NNN>_*.sql` (relax CHECK + add UPDATE grant + add transition RLS policy), `tests/rls-contract/synthetic-schema.sql`, this doc §2 + §3 |
| Add an `EVENT_TYPES` entry for a review-queue event | `src/memory/audit.js`, GM-22 adversarial C1 + GM-23 E10 snapshots, this doc §9 |
| Add a read API (`listReviewQueue`, `getReviewItem`) | `src/review/repository.js` + `src/review/index.js`, `tests/review/`, `check-review-boundary.js` (allow SELECT keyword), this doc §4 |
| Add a new column | migration, synthetic schema, fixtures, runners, this doc §2 |
| Relax the `decision_intent_type` or `decision_reason` CHECK | migration, synthetic schema, this doc §2, paired with `src/governance/intents.js` / `decisions.js` widening (GM-21 lock change) |
| Mount the queue from boot or expose an HTTP surface | `src/runtime/boot.js`, `check-review-boundary.js`, this doc §1 + §8 + new operator runbook section |

## Cross-references

- `source-of-truth-memory-policy.md` — the privacy policy the
  classifier (and therefore the queue) mechanically enforces.
- `governance-runtime-boundary.md` — the classifier and Decision
  shape the actor consumes.
- `actor-runtime-boundary.md` — the actor contract this layer
  extends with a second actor.
- `rls-privacy-contract.md` — the engaged RLS policies (now
  including the GM-23 review-queue policies).
- `memory-runtime-boundary.md` — orthogonal; the review queue does
  not write memory.
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../db/migrations/008_review_queue.sql` — the migration.
- `../../src/review/` — the persistence library.
- `../../src/actors/review-queue-actor.js` — the Decision-gated
  actor.
- `../../tests/integration/review-queue.test.js` — the integration
  contract proof.
- `../../tests/governance/adversarial.test.js` — the negative E
  series.
