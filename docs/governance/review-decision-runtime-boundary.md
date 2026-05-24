# Review-Decision Runtime Boundary

**Applies to:** the review-decision substrate (`src/review/`
repository functions `listPendingReviewItems`,
`inspectReviewItem`, `recordReviewDecision`; the new
`src/actors/review-decision-actor.js` actor; and the
`governance_review_decisions` table created by
`db/migrations/009_review_decisions.sql`). Introduced in GM-24 —
the second persistence expansion since the process lock,
extending the GM-23 review-queue substrate with a parallel
append-only artifact for the human reviewer's outcome.
**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, an UPDATE path, a new reviewer role,
or relaxing the CHECK constraints requires paired updates to
this document, the migration chain, the rls-contract synthetic
suite, and the adversarial snapshot tests
(`tests/governance/adversarial.test.js` C2/C3/C4).
**Depends on:** `review-queue-runtime-boundary.md` (the GM-23
substrate this layer reviews), `governance-runtime-boundary.md`
(the classifier + Decision shape the actor consumes),
`actor-runtime-boundary.md` (the actor contract),
`rls-privacy-contract.md` (the engaged RLS policies),
`memory-runtime-boundary.md` (orthogonal — the review-decision
substrate does not write memory).

## Purpose

GM-23 made `requires_review` Decisions durably stageable. But the
queue could only be filed; it could not be read for review and no
artifact recorded a reviewer's decision. The queue was write-only.

GM-24 adds the smallest possible **review-outcome** substrate:

- a human admin can **list pending review items** in their pilot,
- a human admin can **inspect one pending item** (payload +
  evidence),
- a human admin can **record a review outcome** (`approved` |
  `rejected`) against a pending item,
- the recorded outcome is **immutable** and **append-only**,
- each queue item is reviewable **exactly once**
  (`UNIQUE(review_queue_id)`),
- a reviewer **cannot review their own staged item**
  (BEFORE-INSERT trigger),
- the underlying queue row is **never mutated** — the GM-23
  immutability invariant holds.

The substrate is **inert**. It records. Nothing in GM-24 reads
the recorded decisions for action, executes the approved item,
mutates memory, schedules background work, or notifies external
systems. A future execution surface (a separate decision gate)
would be required to consume `governance_review_decisions` rows.

The constitutional rule:

> **Approval is not authorization. Authorization is not execution.**

GM-24 records review outcomes. It does not authorize or execute.

## 1. Module placement (extending the GM-23 surface)

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes listPendingReviewItems,
                       inspectReviewItem, recordReviewDecision in
                       addition to stageReviewItem.
  repository.js      — extended: 3 new functions + the GM-24 locked
                       vocabularies (VALID_REVIEW_OUTCOMES,
                       VALID_REVIEW_REASONS). DEFAULT_LIST_LIMIT = 50,
                       MAX_LIST_LIMIT = 200.
  index.js           — public surface unchanged (handle, transaction,
                       error). New ops are reached via the ctx the
                       caller receives from withReviewContext.

src/actors/
  outcomes.js        — + OUTCOMES.RECORDED = 'recorded'
  review-decision-actor.js   — NEW. createReviewDecisionActor.
  index.js           — + createReviewDecisionActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_review_decisions'
  - INSERT_ALLOWED_TABLES += 'governance_review_decisions'
  every other ban unchanged.

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — UNCHANGED.

docs/governance/review-decision-runtime-boundary.md  — NEW (this doc).
db/migrations/009_review_decisions.sql               — NEW.
```

## 2. Schema (`governance_review_decisions`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `review_queue_id` | UUID NOT NULL | part of composite FK below; UNIQUE on its own |
| `reviewer_user_id` | UUID NOT NULL | part of composite FK below |
| `reviewer_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `review_outcome` | TEXT NOT NULL | CHECK in `('approved','rejected')` |
| `review_reason` | TEXT NOT NULL | CHECK in 5-value vocabulary (§4) |
| `reviewed_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (review_queue_id)` |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite FK targets |
| — | — | composite FK `(pilot_instance_id, reviewer_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, review_queue_id)` → `governance_review_queue` |

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No CHECK / UPDATE policy could permit the operation even if a grant were added.

**Self-review prevention — BEFORE-INSERT trigger** looks up
`governance_review_queue.proposer_user_id` for the referenced
queue row; if it equals `NEW.reviewer_user_id`, the trigger
raises `governance_review_decisions: reviewer ... cannot review
their own staged item (self-review forbidden)`. This is the
authoritative wall; the actor performs the same check for early
failure but a raw INSERT that bypasses the actor still hits the
trigger.

## 3. RLS policies

Three policies on `governance_review_decisions`:

- **`review_decisions_insert_admin`** (INSERT WITH CHECK):
  `pilot_instance_id = current_setting('app.pilot_instance_id')`
  AND `reviewer_user_id = current_setting('app.user_id')`
  AND `current_setting('app.user_role') = 'admin'`. Enforces
  tenant + no-impersonation + admin-only.
- **`review_decisions_admin_select`** (SELECT): tenant match +
  `app.user_role = 'admin'`. Admins see all review decisions in
  their pilot.
- **`review_decisions_proposer_select`** (SELECT): tenant match +
  the row references a `governance_review_queue` row whose
  `proposer_user_id = app.user_id`. The original proposer of the
  underlying queue item learns the outcome of their staged item.

No family / caregiver / system SELECT policy. No UPDATE or DELETE
policy. The `governance.review.decide` intent type is the only
classifier admit path for this actor.

## 4. Locked vocabularies

`review_outcome` ∈ `('approved', 'rejected')`. Two values; no
others. CHECK constraint mirrors the JS-side
`VALID_REVIEW_OUTCOMES`.

`review_reason` ∈ `(
  'approved_admin_review',
  'rejected_insufficient_evidence',
  'rejected_policy_violation',
  'rejected_duplicate',
  'rejected_admin_review'
)`. Five values. CHECK constraint mirrors
`VALID_REVIEW_REASONS`. Adding a value requires paired updates
to the migration, repository, actor, doc, and adversarial
snapshot tests.

`reviewer_role` ∈ `('admin')`. One value. Widening to senior /
caregiver / future `reviewer` role is its own decision gate; it
would require paired updates to the CHECK, the actor's role
check, the RLS INSERT policy, and the doc.

## 5. Public API surface (GM-23 + GM-24)

| Export | Purpose |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes four operations (see below) |
| `ReviewRepositoryError` | unchanged |

Inside the `fn(ctx)` callback the caller receives:

| Operation | Status |
|---|---|
| `ctx.stageReviewItem(input)` | GM-23 (unchanged) |
| `ctx.listPendingReviewItems({limit?})` | GM-24 NEW |
| `ctx.inspectReviewItem(queueId)` | GM-24 NEW |
| `ctx.recordReviewDecision(input)` | GM-24 NEW |

No raw pg client is exposed.

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 NEW |
| `OUTCOMES` enum | extended: `RECORDED` added |

Operations explicitly NOT in this surface:
- Any UPDATE / DELETE op on either review table (append-only).
- Any "approve and execute" path (no consumer exists in GM-24).
- Any read API for `governance_review_decisions` other than the
  RLS-narrowed admin + proposer SELECT (no list/inspect helper
  is exposed; admins can query via the SELECT policy directly
  through the same `lylo_app` pool when needed by a future GM).
- Any notification / scheduler / poller (none exist).

## 6. Decision-verification chain (the seventh layer is admin-only)

The review-decision actor inherits the GM-22 / GM-23 verification
chain and adds an actor-specific seventh layer:

| # | Check | Catches |
|---|---|---|
| 1 | `instanceof Decision` | Plain-object duck-types |
| 2 | `isValidDecision` (WeakSet) | Prototype-tampering forgeries |
| 3 | `Object.isFrozen(decision)` | Mutation post-classification |
| 4 | `decision.intentType === GOVERNANCE_REVIEW_DECIDE` | Wrong intent type |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` non-empty | Vocabulary drift |
| 6 | `decision.decision === ADMISSIBLE` | Outcome confusion (defense in depth — the classifier always returns admissible for this intent type) |
| 7 | `params.userRole === 'admin'` | Non-admin reviewer (rejected BEFORE any DB call) |

Plus parameter validation: `pilotInstanceId` / `userId` /
`reviewQueueId` UUID-shaped; `reviewOutcome` ∈
`VALID_REVIEW_OUTCOMES`; `reviewReason` ∈
`VALID_REVIEW_REASONS`.

Any verification failure throws. The pool is not consulted on
any failure path.

The DB layer enforces the same (and more) authoritatively:
- RLS WITH CHECK enforces tenant + reviewer match + admin role.
- BEFORE-INSERT trigger enforces no-self-review.
- UNIQUE catches double-review.
- Composite FK catches cross-pilot review-queue references.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-24):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics on both tables; module has no UPDATE/DELETE grants. |
| FROM/JOIN allowlist = `governance_review_queue`, `governance_review_decisions`, `users`, `pilot_instances` | The module reads only these tables. |
| INSERT INTO allowlist = `governance_review_queue`, `governance_review_decisions` | The module writes only these tables. |
| `pg` import scoped to `src/review/client.js` only | One pg-aware file. |
| Every model SDK forbidden | The substrate calls no model. |
| HTTP/server framework forbidden | No HTTP. |
| `child_process`/`worker_threads`/`cluster` forbidden | No subprocess, no worker. |
| `setInterval`/`setImmediate`/`cron`/`schedule` forbidden | No scheduling. (`setTimeout` permitted — pg pool uses it internally.) |
| `fs.write*`/`appendFile*`/`createWriteStream`/`mkdir*`/`rm*`/`unlink*` forbidden | No filesystem writes. |
| `insertPrivateMemory` identifier forbidden | Defense in depth — no memory writes. |
| Streaming + tool-calling identifiers forbidden | Defense in depth. |

The boundary guard does NOT widen for any other module —
`src/actors/review-decision-actor.js` is governed by
`scripts/ci/check-actors-boundary.js` (the existing
`../review` public-entry allowance from GM-23 covers it).

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording a review outcome mutates the underlying queue row | Queue table append-only (GM-23) + the new substrate writes only to `governance_review_decisions`. |
| Recording a review outcome executes the proposal | No consumer exists; no actor reads `governance_review_decisions` operationally; doc forbids it. |
| Reviewing one's own staged item | BEFORE-INSERT trigger + actor-level check (defense in depth at the actor; trigger is authoritative). |
| Reviewing twice for the same queue item | `UNIQUE(review_queue_id)` + actor layer 7 catches non-admin attempts even earlier. |
| Cross-pilot review | Composite FK `(pilot_instance_id, review_queue_id) → governance_review_queue` + RLS WITH CHECK. |
| Non-admin recording a review | RLS WITH CHECK (admin role) + actor layer 7. |
| Reviewer impersonation via input | Actor sources `reviewer_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded review | Append-only trigger + no UPDATE/DELETE grants. |
| Adding a new review_outcome / review_reason without paired update | CHECK constraint + adversarial snapshot tests. |
| EVENT_TYPES widening | None. `governance_review_decisions` IS the artifact (per OQ-24.9). Adversarial test F11 asserts the lock. |

## 9. Adversarial review additions (F-series)

`tests/governance/adversarial.test.js` is extended with the
F-series (F1–F12) covering the GM-24 actor. Plus C-series
snapshot updates: C2 (REASONS now 12 values), C3 (INTENT_TYPES
now 9 values), C4 (OUTCOMES now 5 values, NEW).

| # | Probe | Defense |
|---|---|---|
| F1 | Plain-object Decision | Layer 1 (`instanceof`) |
| F2 | Prototype-tampered Decision | Layer 2 (WeakSet) |
| F3 | Decision with wrong intent type | Layer 4 |
| F4 | Decision with wrong outcome | Layer 4 / 6 |
| F5 | Non-admin role | Layer 7 |
| F6 | reviewOutcome outside vocabulary | param validation + DB CHECK |
| F7 | reviewReason outside vocabulary | param validation + DB CHECK |
| F8 | Non-UUID ids | param validation |
| F9 | Reviewer impersonation by input | actor ignores input; RLS WITH CHECK |
| F10 | Sentinel content in unknown params field | logger metadata-only |
| F11 | EVENT_TYPES snapshot | unchanged |
| F12 | Sole production path is classifier | smoke test |

Integration suite (`tests/integration/review-decision.test.js`)
covers the DB-side counterparts: self-review trigger, double-
review UNIQUE, cross-pilot FK + RLS, non-admin RLS WITH CHECK,
append-only trigger, lylo_runtime GRANT denial, CHECK rejection
of bad vocabulary.

## 10. Logging hygiene

The review-decision actor logs ONE event per recorded outcome:
`actor.review_decision.recorded` with typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `review_decision_id` (UUID)
- `review_queue_id` (UUID)
- `review_outcome` (locked GM-24 vocabulary)
- `review_reason` (locked GM-24 vocabulary)
- `reviewer_user_id` (UUID)
- `reviewer_role` (admin)

The actor does NOT log: the queue item's `payload_summary`,
`evidence_summary`, or any other content. F10 plants a sentinel
in an unknown params field and asserts it never appears in any
captured log line.

The locked vocabularies for `review_outcome` and `review_reason`
ARE logged as typed metadata; they carry no caller content. If a
future GM widens these to include free-text fields (e.g. a
`reviewer_notes` JSONB), that change requires a paired sentinel
scan extension.

## 11. Change control

Adding a new review_outcome, a new review_reason, a new
reviewer_role, an UPDATE / DELETE grant, a status transition, a
read API beyond the three GM-24 ops, or a production consumer of
`governance_review_decisions` is a boundary change. It requires
a reviewed change to:

- this document,
- `db/migrations/0NN_*.sql` (next number),
- `tests/rls-contract/synthetic-schema.sql`,
- `tests/rls-contract/policies.sql`,
- `tests/rls-contract/fixtures.sql`,
- `tests/rls-contract/run-contract.js`,
- `tests/rls-contract/run-real.test.js`,
- `tests/governance/adversarial.test.js` (snapshot + new probes),
- `scripts/ci/check-review-boundary.js` if read/write allowlists
  shift,
- `src/governance/intents.js` / `decisions.js` / `classifier.js`
  if new vocabulary lands.

When the change introduces a consumer of recorded review
decisions, the same PR MUST explicitly establish whether the
consumer is mounted, what its boundary guard is, what its
adversarial review covers, and what its OQ set looked like. A
silent consumer is the failure mode this substrate is designed
to prevent.

## Cross-references

- `review-queue-runtime-boundary.md` — the GM-23 staging substrate.
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-24 with the third Decision-gated actor).
- `governance-runtime-boundary.md` — classifier + Decision shape
  (extended in GM-24 with one intent type + one reason).
- `rls-privacy-contract.md` — engaged RLS policies (extended in
  GM-24 with the three new policies on
  `governance_review_decisions`).
- `baseline-ci.md` — CI guard set (review boundary guard extended).
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/review-decision-actor.js` — the actor.
- `../../db/migrations/009_review_decisions.sql` — the migration.
- `../../tests/integration/review-decision.test.js` — integration
  proof.
- `../../tests/governance/adversarial.test.js` — F-series
  negative tests.
