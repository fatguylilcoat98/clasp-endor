# Actor-Runtime Boundary

**Applies to:** the actor-runtime module in `src/actors/` — the
first code outside `src/governance/` that consumes a
classifier-produced Decision and acts on it. Introduced in GM-22;
extended in GM-23 to add a second Decision-gated actor (the
review-queue actor).
**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-actors-boundary.js` in the same PR.
Adding a new actor (or relaxing the import allowlist) requires a
paired update to this document.
**Depends on:** `governance-runtime-boundary.md` (the
classifier and Decision shape this layer consumes);
`conversation-runtime-boundary.md` (the only downstream
capability GM-22's actor wraps);
`review-queue-runtime-boundary.md` (the GM-23 substrate the
review-queue actor stages into); `companion-runtime-boundary.md`
and `memory-runtime-boundary.md` (orthogonal — neither GM-22's
nor GM-23's actor imports either).

## Purpose

GM-21 introduced the execution-decision classifier and the
opaque `Decision` class. The classifier said: "future actors
will require a `Decision` instance — they cannot act on a raw
intent." Until GM-22, that contract was documented but not
mechanically enforced.

GM-22 ships the **first actor**. The actor's existence is the
first mechanical proof that "you cannot act without a Decision":

- The actor's `execute(decision, params)` method requires a
  `Decision` as its first argument.
- A multi-layer verification chain (described in §3) rejects
  forged, tampered, mismatched-intent-type, or vocabulary-invalid
  Decisions.
- On a verified-but-not-admissible Decision, the actor returns a
  structured abstained/rejected outcome WITHOUT calling the
  downstream runtime.

The downstream runtime (the GM-20 conversation runtime) is still
independently callable in GM-22 (OQ-22.8 — no API break). A
future GM may close the direct-caller seam; until then, the
actor is the recommended path.

## 1. Module placement

```
src/runtime/      — config loader; never imports actors/.
src/db/           — runtime pool; never imports actors/.
src/memory/       — memory library; never imports actors/.
src/companion/    — read-only consumer; never imports actors/.
src/conversation/ — single-shot model runtime; never imports
                    actors/. (The actor wraps the runtime, not the
                    other way around.)
src/governance/   — pure classifier (leaf); never imports actors/.
src/actors/       — GM-22: first Decision-gated executor
                    (response-delivery actor wrapping the
                    conversation runtime). GM-23: second
                    Decision-gated executor (review-queue actor
                    wrapping the GM-23 review-queue substrate).
                    Imports `../governance` (public entry only,
                    for the Decision contract), `../conversation`
                    (public entry only — response-delivery actor),
                    and `../review` (public entry only — review-
                    queue actor). NO pg, NO model SDKs (including
                    @anthropic-ai/sdk — that boundary belongs to
                    the conversation runtime), NO HTTP frameworks,
                    NO scheduling (other than transitive setTimeout
                    via the runtime), NO fs writes, NO subprocesses,
                    NO worker threads. Guarded by
                    check-actors-boundary.js.
```

Future GMs that introduce additional actors (e.g. a memory-
candidate actor) will add new files under `src/actors/` or
sub-directories. Each new actor gets its own intent-type contract
and may extend the boundary guard's allowed-import list (e.g. to
permit `../memory` entry imports). Every such extension is a
deliberate boundary change.

## 2. Public API surface (GM-22 + GM-23 + GM-24)

| Export | Purpose |
|---|---|
| `createResponseDeliveryActor({conversationRuntime, log?})` | GM-22. Factory. Returns a frozen actor with exactly one method, `execute(decision, params)`. The caller injects an already-constructed conversation runtime (so the actor is testable with a mocked runtime — no model dependency in unit tests). |
| `createReviewQueueActor({reviewQueuePool, log?})` | GM-23. Factory. Returns a frozen actor with exactly one method, `execute(decision, params)`. Stages `requires_review` Decisions into `governance_review_queue` via the GM-23 review-queue substrate. |
| `createReviewDecisionActor({reviewQueuePool, log?})` | GM-24. Factory. Returns a frozen actor with exactly one method, `execute(decision, params)`. Records a human admin's review outcome (`approved` \| `rejected`) against a pending queue item, into `governance_review_decisions`. **Admin role only.** Recording is NOT execution; approval is NOT authorization. |
| `OUTCOMES` | Frozen `{EXECUTED, ABSTAINED, REJECTED, STAGED, RECORDED}` enum. `RECORDED` is the GM-24 addition; the five-way set is snapshot-locked in the adversarial suite (C4). |

Internal helpers (`verifyDecisionOrThrow`, `validateParams`,
`isConversationRuntime`, `isReviewQueuePool`) are NOT re-exported
through `src/actors/index.js`. Each returned actor exposes only
`execute`.

## 3. Decision-verification chain (the central GM-22 contract)

Every call to `actor.execute(decision, params)` runs the
following verification on `decision` BEFORE any downstream work
(OQ-22.3):

| # | Check | Catches |
|---|---|---|
| 1 | `decision instanceof Decision` | Plain-object duck-types, primitives, null/undefined, arrays, functions. |
| 2 | `isValidDecision(decision)` (consults the classifier's module-private WeakSet) | **Prototype-tampering forgery.** An attacker can construct a `{intentType, decision, reason, policyRef}` shape, call `Object.setPrototypeOf(fake, Decision.prototype)` and `Object.freeze(fake)`. The result passes `instanceof Decision` AND `Object.isFrozen`. The WeakSet check rejects it because the fake was never added by `_createDecision` — only the classifier's path adds to the set. |
| 3 | `Object.isFrozen(decision)` | A genuine Decision that somehow got mutated (this should be impossible — the classifier freezes it — but defense in depth). |
| 4 | `decision.intentType === INTENT_TYPES.RESPONSE_DELIVER` | Type confusion. The response-delivery actor refuses Decisions for any other intent type (e.g. a real `memory.candidate.create` Decision will not pass). |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` is a non-empty string | Vocabulary drift. Redundant with the Decision constructor's own checks; defense in depth in case a future refactor weakens them. |

**Failure mode: THROW.** Any verification failure throws a
descriptive Error. A forged or tampered Decision indicates broken
caller code, not a classification result — the caller should not
be able to "handle" this with a structured outcome. The runtime
is not consulted on any failure path.

The closes-prototype-tampering check (rule 2) is the GM-22
addition to GM-21's Decision shape. `isValidDecision` is exported
from `src/governance/index.js`; the underlying WeakSet is
private to `src/governance/decisions.js`.

## 4. Outcome routing (OQ-22.4)

After verification, the actor routes by `decision.decision`:

| `decision.decision` | Action | Outcome shape |
|---|---|---|
| `admissible` | Calls `conversationRuntime.respond(params)` exactly once | `{outcome: 'executed', decision, response, memoryCount}` |
| `requires_review` | Does NOT call the runtime | `{outcome: 'abstained', decision}` |
| `inadmissible` | Does NOT call the runtime | `{outcome: 'rejected', decision}` |

All three outcome shapes are `Object.freeze`d.

A note on the GM-22 actor specifically: the GM-21 classifier
returns `admissible` for `response.deliver`, period. There is no
classification path that yields `requires_review` or
`inadmissible` for `response.deliver`. The abstained/rejected
branches in the actor are therefore **defense in depth** — they
guarantee correct behavior if a future classifier change starts
returning non-admissible outcomes for `response.deliver`, AND
they make the contract visible for future actors that handle
intent types with richer outcome spaces.

### 4a. The review-queue actor (GM-23) — sixth verification layer

The review-queue actor extends the five-layer chain with a
**sixth, actor-specific** layer:

| # | Check | Catches |
|---|---|---|
| 6 | `decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW` | Staging the wrong kind of Decision. Admissible Decisions belong with the response-delivery actor (or its future siblings); inadmissible Decisions get recorded and dropped by their caller. Only `requires_review` belongs in the queue. |

The intent-type check (layer 4) is also different for the review-
queue actor. Unlike the response-delivery actor, which locks
`decision.intentType` to `RESPONSE_DELIVER`, the review-queue
actor accepts **any** value from `INTENT_TYPES` — any intent
type can in principle be classified `requires_review`, and the
queue stages all of them.

Outcome routing for the review-queue actor:

| `decision.decision` | Action | Outcome shape |
|---|---|---|
| `requires_review` (only) | One INSERT into `governance_review_queue` via `withReviewContext` | `{outcome: 'staged', decision, queueEntryId, createdAt}` |
| `admissible` | THROW (layer 6 rejects — does not call the substrate) | — |
| `inadmissible` | THROW (layer 6 rejects — does not call the substrate) | — |

The substrate's RLS policies (`tenant + no-impersonation`) are
the **outer** correctness gate. The actor's verification is
defense-in-depth for upstream callers; the database refuses
forged inserts even if the actor were bypassed entirely. See
`review-queue-runtime-boundary.md` for the full substrate
contract.

### 4b. The review-decision actor (GM-24) — seventh verification layer

The review-decision actor extends the chain with an actor-
specific **seventh** layer and a different layer-4 lock:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE` | Wrong intent type (response.deliver / memory.* / vault.* / external.* / governance.review.decide is the only admit) |
| 6 | `decision.decision === DECISION_OUTCOMES.ADMISSIBLE` | Outcome confusion — the classifier always returns admissible for this intent type; this is defense in depth |
| 7 | `params.userRole === 'admin'` | Non-admin recording a review outcome. Rejected BEFORE any DB call. The actor is the early-failure gate; RLS WITH CHECK is the authoritative wall. |

Plus parameter validation: `reviewQueueId` UUID-shaped;
`reviewOutcome ∈ ('approved','rejected')`; `reviewReason ∈`
the locked 5-value vocabulary. Vocabulary CHECKs at the DB layer
are the authoritative wall.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All seven verification layers + param validation pass | One INSERT into `governance_review_decisions` via `withReviewContext` | `{outcome: 'recorded', decision, reviewDecisionId, reviewedAt}` |
| Any failure | THROW (before any DB call) | — |

The substrate is defended four ways at the DB layer (RLS
WITH CHECK on admin + tenant + no-impersonation; composite FKs;
BEFORE-INSERT self-review trigger; UNIQUE on `review_queue_id`).
The actor's role/vocabulary checks are early-failure
defense-in-depth; the trigger and constraints are
unbypassable. See `review-decision-runtime-boundary.md` for the
full substrate contract.

**The constitutional rule (added in GM-24):** *approval is not
authorization; authorization is not execution.* The
`OUTCOMES.RECORDED` value names the act of recording a review
outcome — it is not a signal to act, and no production code in
GM-24 consumes recorded review decisions for any operational
purpose.

## 5. The conversation runtime is unchanged

GM-22 does NOT modify `src/conversation/`. Direct callers of
`conversationRuntime.respond(...)` continue to work exactly as
they did after GM-20. The actor is a wrapper, not a gate;
mechanically, callers can still skip it.

The structural enforcement of "you cannot act without a
Decision" therefore lives at the **actor's** entry, not at the
runtime's entry. If the conversation runtime is ever mounted
from a production caller in a future GM, that GM will need to
decide whether to route through the actor or to wrap the runtime
in its own Decision gate. That is its own decision gate.

## 6. Forward-binding convention for future actors

When a future GM introduces a new actor (e.g. for
`memory.candidate.create`), it must satisfy:

1. **Accept a Decision as its first argument.** Use
   `instanceof Decision` + `isValidDecision` + frozen +
   intentType + structural revalidation, identical to GM-22's
   chain.
2. **Verify `decision.intentType` matches the actor's specific
   intent type.** Never accept a Decision for a different intent.
3. **Route by `decision.decision` to executed / abstained /
   rejected outcomes.** Use the same `OUTCOMES` enum.
4. **Never call the downstream capability before verification
   succeeds.** The downstream call must happen inside the
   admissible branch only.
5. **Emit operational logs only.** Persistent audit rows
   (`governance_audit_log`) are tied to data-mutation paths and
   the locked `EVENT_TYPES` vocabulary; adding a new audit event
   type is its own paired change to the GM-18 lock.
6. **Add a paired entry to the actors boundary guard** if the
   actor needs to import a new downstream layer (e.g.
   `../companion`, `../memory`). The current guard rejects those
   imports because the GM-22 actor does not need them.

## 7. Boundary guard

`scripts/ci/check-actors-boundary.js` scans `src/actors/` only
and fails the build on:

| Rule | Why |
|---|---|
| Any forbidden SQL keyword (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`/`SELECT`/`FROM`/`JOIN`/`WHERE`) | Actors are dispatchers, not data-access code. |
| The identifier `insertPrivateMemory` | Defense in depth — GM-22's actor does not write memory. |
| Import of `pg` | No direct DB access. |
| Import of any model SDK (`@anthropic-ai/sdk`, `openai`, `@openai/*`, etc.) | The conversation runtime owns the SDK boundary; the actor is one layer up. |
| Import of `http`/`https`/`express`/`fastify`/`koa`/`@hapi/hapi` | No HTTP. |
| Import of `child_process`/`worker_threads`/`cluster` (or their `node:` forms) | No subprocess, no worker thread. |
| Import of `../runtime`/`../db`/`../setup`/`../memory`/`../companion` (or subpaths) | Cross-layer reach is forbidden in GM-22 + GM-23 actors; future actors that need a particular layer will get a paired guard update. |
| Imports of `../governance/<deeper>`, `../conversation/<deeper>`, or `../review/<deeper>` | Only the public entries (`../governance`, `../governance/index`, `../conversation`, `../conversation/index`, `../review`, `../review/index`) are permitted. The `../review` entry was added in GM-23 (paired guard change with `check-actors-boundary.js`). |
| Scheduling identifiers (`setInterval`, `setImmediate`, `cron`, `schedule`) | No background work. `setTimeout` is permitted because it may appear transitively via the conversation runtime; GM-22's actor code does not call it directly. |
| Streaming / tool-calling identifiers (`.stream(`, `messages.stream`, `stream: true`, `tools`, `tool_choice`, `tool_use`, `tool_result`) | Defense in depth; the underlying conversation runtime already bans these. |
| `fs.writeFile*` / `appendFile*` / `createWriteStream` / `mkdir*` / `rm*` / `unlink*` | No filesystem writes. |

## 8. Adversarial review (the new gauntlet contribution)

`tests/governance/adversarial.test.js` is the project's first
**negative test surface**. Every assertion is "this must NOT
work". Per the GM-22 process lock, every high-risk GM going
forward must include or extend this suite with adversarial
probes against the contract it relies on.

The current suite covers:

- **A. GM-21 Decision opacity** — external constructor throws;
  `_createDecision`/`_TOKEN`/`_BLESSED` are not re-exported;
  mutation throws; classifier handles adversarial inputs
  (Proxies, frozen inputs, Symbol keys, `__proto__` payloads,
  injected-SQL-looking strings, oversized payloads) without
  throwing and without emitting to stdout.
- **B. GM-22 actor verification** — duck-typed objects rejected;
  prototype-tampered forgeries rejected by the WeakSet check;
  type-confusion (Decisions for the wrong intent type) rejected;
  non-object decision arguments rejected; classifier-produced
  Decisions are reusable (stateless actor); runtime errors
  surface cleanly without altering the Decision.
- **E. GM-23 review-queue actor verification** — duck-typed
  objects rejected; prototype-tampered forgeries rejected by the
  WeakSet check; admissible / inadmissible Decisions rejected by
  layer 6; cross-tenant impersonation rejected by RLS WITH CHECK
  in the integration suite; sentinel payload/evidence content
  never appears in actor or repository log lines (E1–E10).
- **C. EVENT_TYPES + REASONS + INTENT_TYPES snapshots** — the
  GM-18 audit vocabulary, the GM-21 REASONS vocabulary, and the
  GM-21 intent taxonomy are snapshot-locked. Any addition or
  removal fails this test, forcing a paired review of the
  governance docs.
- **D. The contract holds end-to-end** — no forgery the test
  suite can construct gets through; the classifier is the only
  production path to a Decision the actor accepts; mutation
  attempts (which fail at freeze-time) do not affect actor
  routing; and no side-channel writes to stdout when the
  classifier and the actor handle adversarial inputs.

Future high-risk GMs are expected to add scenarios specific to
the contract they introduce.

## 9. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| Actor executes without a Decision | `execute(decision, ...)` requires the Decision argument; instanceof + WeakSet checks reject every non-classifier-produced input. |
| Actor accepts a forged Decision (prototype tampering) | `isValidDecision` (GM-22 WeakSet check) rejects every object not produced by `_createDecision`. Adversarial test B2 plants the exact forgery and asserts rejection. |
| Actor accepts a Decision for the wrong intent type | Intent-type confusion check (rule 4 above). Adversarial test B3. |
| Actor accepts a mutated Decision | Frozen check + the Decision constructor's own freeze. Adversarial test A5. |
| Actor executes on requires_review or inadmissible | Outcome routing branches; runtime not called. Tests assert `getCalls() === 0` on those paths. |
| Actor loops, retries, or schedules work | Stateless module; boundary guard bans `setInterval`/`setImmediate`/scheduling identifiers; single-call shape. |
| Actor writes to DB | Boundary guard bans `pg` and cross-layer imports of `../memory`/`../companion`. |
| Actor calls a model SDK | Boundary guard bans every model SDK by name. The actor calls `conversationRuntime.respond`, which is a method on an injected client; the actor never imports the SDK. |
| Actor introduces new audit `EVENT_TYPES` | None added in GM-22. Adversarial test C1 snapshots and asserts the lock holds. |
| Actor adds new endpoints / mounts to boot | Boundary guard bans HTTP frameworks. `src/runtime/boot.js` does not import `src/actors/`. |
| Actor logs response text / user message / memory content | Sentinel-scan unit test (`tests/actors/response-delivery-actor.test.js`) plants secrets in both the user message and the model response and asserts neither appears in any captured log line. The review-queue actor has its own sentinel scan (`tests/actors/review-queue-actor.test.js`) covering `payload_summary` and `evidence_summary`. |
| Review-queue actor stages a non-requires_review Decision | Layer 6 check (`decision.decision === REQUIRES_REVIEW`). Adversarial tests E2 / E3 plant admissible and inadmissible Decisions and assert rejection BEFORE any pool call. |
| Review-queue actor inserts under a forged tenant or impersonated proposer | The actor passes `proposer_user_id` from the session context, not from input. `withReviewContext` sets `app.user_id` via `set_config`, and the RLS `review_queue_insert_own` WITH CHECK enforces both tenant and proposer match. Adversarial E5 + integration suite plant the attack. |
| Review-queue actor mutates an existing queue row | No UPDATE / DELETE grants to `lylo_app`; the `governance_review_queue` BEFORE-UPDATE-OR-DELETE trigger raises on any attempt. Integration suite asserts. |

## 10. Enforcement summary

| Property | Enforced by |
|---|---|
| SQL / identifier / module-import bans | `check-actors-boundary.js` (CI) |
| Public-entry-only imports of `../governance` and `../conversation` | `check-actors-boundary.js` (CI) |
| Decision verification chain (5 layers including WeakSet) | `tests/actors/response-delivery-actor.test.js` (unit) + `tests/governance/adversarial.test.js` (negative) |
| Outcome routing per `decision.decision` | unit + adversarial |
| Runtime called exactly once on admissible, zero times on any other path | unit + adversarial |
| Sentinel privacy (user message + response + memory payload never appear in logs) | unit + adversarial |
| `EVENT_TYPES` / `REASONS` / `INTENT_TYPES` vocabulary locks | `tests/governance/adversarial.test.js` snapshots |

## 11. Change control

Adding a new actor, relaxing the boundary guard's import
allowlist, introducing a new actor-emitted operational event,
adding a new audit `EVENT_TYPES` entry, or mounting the actor
from boot is a boundary change. It requires a reviewed change
to this document **and** `check-actors-boundary.js` in the same
PR. When the change touches the GM-18 audit-vocabulary lock,
the same PR must update `src/memory/audit.js` `EVENT_TYPES`
AND the adversarial snapshot.

## Cross-references

- `governance-runtime-boundary.md` — the classifier and Decision
  shape this layer consumes.
- `conversation-runtime-boundary.md` — the downstream capability
  GM-22's response-delivery actor wraps.
- `review-queue-runtime-boundary.md` — the GM-23 substrate the
  review-queue actor stages into.
- `companion-runtime-boundary.md`, `memory-runtime-boundary.md`,
  `runtime-boundary.md` — orthogonal layers neither actor imports.
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-actors-boundary.js` — the guard.
- `../../src/actors/` — the module.
- `../../tests/actors/response-delivery-actor.test.js` — the
  GM-22 positive contract tests.
- `../../tests/actors/review-queue-actor.test.js` — the GM-23
  positive contract tests.
- `../../tests/governance/adversarial.test.js` — the negative
  contract tests (A–E series).
