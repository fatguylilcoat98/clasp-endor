# Governance-Runtime Boundary

**Applies to:** the execution-decision module in `src/governance/`
— the first layer that distinguishes "the model generated this"
from "the system authorized operational consequence from this".
Introduced in GM-21.
**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-governance-boundary.js` in the same PR.
Adding a new intent type, a new outcome, or a new REASON requires
paired updates to `src/governance/intents.js`,
`src/governance/decisions.js`, and `src/governance/classifier.js`,
plus this document.
**Depends on:** `source-of-truth-memory-policy.md` (the policy the
classifier mechanically enforces a subset of),
`conversation-runtime-boundary.md` (the response-delivery surface
the classifier permits), `companion-runtime-boundary.md` (the
read-only data path; orthogonal),
`memory-runtime-boundary.md` (the audit-bundled data layer below
companion; orthogonal).

## Purpose

GM-20 introduced the first mounted conversational runtime: the
model produces a response and the conversation runtime returns
it to the caller. **From that point on, there is no governance.**
A caller can act on the response — persist it, send it, treat it
as a directive — and no structural distinction separates "the
model produced this string" from "the system authorized acting
on it."

GM-21 introduces that distinction as a typed, structural
boundary — *before* any actor module exists to act on it. Then
every future action capability has to pass through the same
gate by construction.

The governance module ships:

- A locked taxonomy of execution **intent types**.
- A frozen, opaque **Decision** class that future actor modules
  will require as their input contract.
- A pure-function **classifier** that maps an intent to a
  Decision.

It does **not** ship:

- Any actor module (no execution).
- Any persistence (Decisions are return values).
- Any new audit `EVENT_TYPES` (the GM-18 vocabulary lock is
  unchanged).
- Any boot integration (library-only).
- Any HTTP / scheduling / subprocess / fs-write / model-SDK
  surface.

## 1. Module placement

The governance module is a **leaf**. It imports nothing from any
other `src/` layer. Other layers MAY import it (future GMs);
in GM-21 none do.

```
src/runtime/      — config loader; never imports governance/.
src/db/           — runtime pool; never imports governance/.
src/memory/       — memory library; never imports governance/.
src/companion/    — read-only consumer; never imports governance/.
src/conversation/ — single-shot model runtime; never imports
                    governance/ in GM-21 (the conversation runtime
                    keeps returning raw responses; a future
                    actor — not the runtime — classifies).
src/governance/   — NEW (GM-21). Pure-function leaf. No I/O. No
                    DB. No model SDK. No HTTP. No async. No
                    cross-layer imports. Guarded by NEW
                    check-governance-boundary.js.
```

The recommended layer ordering is orthogonal — the governance
module sits *beside*, not above or below, the data-access stack.
A future actor module (GM-22+) will import both `src/governance/`
(to classify) and one of `src/companion/` or `src/memory/` (to
act). Each actor module will get its own boundary guard.

## 2. Public API surface (GM-21)

| Export | Purpose |
|---|---|
| `classifyExecutionIntent({type, payload?, evidence?})` | Pure, deterministic, stateless. Returns a `Decision`. Default-deny on unknown intent types or malformed inputs (never throws — fail-closed). |
| `Decision` (class) | Frozen, opaque. Future actor modules `instanceof`-check Decision to ensure they only operate on classified intents. The constructor throws when called externally — only the internal `_createDecision` factory (not re-exported) can produce one, and it's called only by the classifier. |
| `INTENT_TYPES` | Locked closed taxonomy of intent types. |
| `DECISION_OUTCOMES` | `'admissible'` / `'requires_review'` / `'inadmissible'`. |
| `REASONS` | Locked vocabulary of decision reasons. Each REASON has a paired policy citation looked up by `Decision.policyRef`. |

Internal helpers (not re-exported through `src/governance/index.js`):

| Symbol | Why internal |
|---|---|
| `_createDecision(fields)` | The only path to construct a Decision. Internal so callers cannot bypass `classifyExecutionIntent`. |
| `_TOKEN` (module-scoped Symbol) | The unforgeable construction token. External code cannot reach it. |
| `POLICY_REFS` | Lookup table from REASON value to documentation citation. Used inside the `Decision` constructor; callers don't need it directly. |

## 3. Intent taxonomy (locked)

| Intent type | Default classification | Reason | Policy citation |
|---|---|---|---|
| `response.deliver` | **admissible** | `response_delivery_permitted` | `conversation-runtime-boundary.md §5` |
| `memory.candidate.create` (provenance `AI_INFERRED`) | **requires_review** | `ai_inferred_requires_review` | `source-of-truth-memory-policy.md §3, §5` |
| `memory.candidate.create` (provenance `USER_STATED`) | **requires_review** | `user_stated_requires_review` | `source-of-truth-memory-policy.md §4` |
| `memory.candidate.create` (provenance `VERIFIED_FACT`) | **inadmissible** | `verified_fact_self_promotion_forbidden` | `source-of-truth-memory-policy.md §2, §3` |
| `memory.candidate.create` (malformed / missing provenance) | **inadmissible** | `malformed_intent_payload` | this doc §3 (default-deny) |
| `memory.visibility.promote` | **inadmissible** | `visibility_promotion_requires_authority` | `source-of-truth-memory-policy.md §12` |
| `memory.retract` | **inadmissible** | `retraction_infrastructure_not_available` | `source-of-truth-memory-policy.md §6` |
| `memory.supersede` | **inadmissible** | `supersession_infrastructure_not_available` | `source-of-truth-memory-policy.md §7` |
| `vault.session.open` | **inadmissible** | `vault_infrastructure_not_available` | `source-of-truth-memory-policy.md §13` |
| `vault.session.revoke` | **inadmissible** | `vault_infrastructure_not_available` | `source-of-truth-memory-policy.md §13` |
| `external.side_effect` | **inadmissible** | `external_side_effects_not_authorized` | this doc §7 |
| Any other intent type | **inadmissible** | `unknown_intent_type` | this doc §3 (default-deny) |
| Malformed input (non-object, non-string type, etc.) | **inadmissible** | `malformed_intent_payload` | this doc §3 (default-deny) |

**Default-deny rule.** Anything the classifier does not positively
recognize as `admissible` is `inadmissible`. New intent types must
be added to `INTENT_TYPES` with a paired classifier branch AND a
paired update to this document; the change-control rule below
requires both.

**Closed taxonomy rule.** There is no `OTHER` or `CUSTOM` intent
type. Every conceivable action must be named and classified.

## 4. Decision shape

```
Decision {
  intentType: string         // echoes the input intent.type;
                             // used by future actors for
                             // type-confusion prevention
  decision:   'admissible' | 'requires_review' | 'inadmissible'
  reason:     <REASONS member>
  policyRef:  <citation from POLICY_REFS[reason]>
}
```

The Decision deliberately does **not** carry:

- `payload` (may contain memory content the Decision must not
  echo)
- `evidence` (may contain raw model output)
- timestamp (purity: the classifier is time-independent; callers
  add wall clock when persisting)
- the original `intent` reference

The class is `Object.freeze`d at construction. Callers cannot
mutate it. The unit test `tests/governance/classifier.test.js`
plants sentinel content in `intent.payload` and `intent.evidence`
and asserts the sentinels appear in **neither** the serialized
Decision **nor** any stdout side channel.

## 5. Classifier semantics

```
classifyExecutionIntent({type, payload?, evidence?}) → Decision
```

Hard properties:

- **Pure.** No I/O. No DB. No model SDK. No mutable module state.
  Same input → identical Decision across N calls.
- **Stateless.** The classifier never sees history, rate counters,
  external policy, or pilot context. Per-pilot enforcement remains
  at the memory + RLS layer below.
- **Deterministic.** Every branch is enumerated; default-deny
  catches anything not enumerated.
- **Total.** The classifier always returns a Decision. It never
  throws on bad input — malformed input returns `inadmissible`
  with `malformed_intent_payload`. Fail-closed is the design.
- **Side-effect-free.** The classifier writes nothing to stdout,
  no logs, no DB, no fs. The unit test asserts this by capturing
  stdout.
- **Does not execute.** The Decision is data; the caller (a future
  actor module, GM-22+) is responsible for honoring it.
- **Does not echo intent.payload or intent.evidence** into the
  returned Decision.

## 6. Forward-binding convention for future actor modules (OQ-21.10)

A future GM that introduces an actor module to execute admissible
decisions must satisfy this contract:

1. **Accept a Decision, not a raw intent.** The actor's
   public-API signature requires a `Decision` instance (use
   `instanceof Decision`). A raw intent is not acceptable input.
2. **Verify `decision.intentType` matches the actor's purpose.**
   An actor implementing `memory.candidate.create` execution must
   reject a Decision whose `intentType` is anything else.
3. **Proceed only if `decision.decision === 'admissible'`.** For
   `requires_review`, the actor queues the intent for review (a
   review-queue mechanism is itself a future GM with its own
   gate). For `inadmissible`, the actor records the rejection and
   abstains.
4. **Emit an audit row for every accepted, deferred, or rejected
   Decision.** The audit row carries `intent_type`, `decision`,
   `reason`, `policyRef`, plus the standard audit fields. A new
   `EVENT_TYPES` constant (e.g. `governance.intent.classified`)
   will be added to `src/memory/audit.js` in the same GM that
   introduces the actor — touching the GM-18 audit vocabulary lock
   is its own paired change.
5. **Never act before classifying.** The actor's boundary guard
   should mechanically reject any code path that calls a
   memory-mutation op without going through the
   classifier-Decision chain.

GM-21 ships the classifier, the Decision shape, and the contract
above. Steps 1–5 are GM-22+ work.

## 6b. First requires-review persistence lands (GM-23)

GM-23 introduces `src/review/` and `src/actors/review-queue-actor.js`
— the first time a `requires_review` Decision can be durably
captured. The substrate (`governance_review_queue`) and the actor
together prove the invariant:

> You cannot persist a review item without a valid `requires_review`
> Decision.

GM-23 does NOT change this module. The classifier's outputs and
the Decision shape are unchanged. What GM-23 adds is the receiving
end: a substrate that mirrors GM-21 intent types + reasons via DB
CHECK constraints, an append-only table (BEFORE-UPDATE-OR-DELETE
trigger raises), three RLS policies (insert_own / proposer SELECT
/ admin SELECT), and the review-queue actor's sixth verification
layer (`decision.decision === REQUIRES_REVIEW`).

`EVENT_TYPES` remains unchanged in GM-23 (per OQ-23.4 — the queue
table IS the artifact; an audit row is redundant). The GM-18 lock
holds; adversarial test C1 still snapshots the locked vocabulary
and E10 asserts no new vocabulary slipped in.

See `review-queue-runtime-boundary.md` for the substrate contract
and `actor-runtime-boundary.md` §4a for the actor's sixth layer.

## 6c. First review-outcome persistence lands (GM-24)

GM-24 introduces `src/actors/review-decision-actor.js` and
extends `src/review/` with three read+write operations
(`listPendingReviewItems`, `inspectReviewItem`,
`recordReviewDecision`). The substrate
(`governance_review_decisions`) and the actor together prove a
new invariant:

> You cannot record a review outcome without admin role + a valid
> `governance.review.decide` Decision + a pending review queue item
> in the same pilot proposed by a different user.

GM-24 widens this module **minimally**: exactly one new intent
type (`INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE`), exactly one new
reason (`REASONS.REVIEW_DECISION_RECORDING_PERMITTED`), exactly
one new policy-ref entry. The classifier branch returns
`admissible` unconditionally for this intent type; role
enforcement (admin only) lives at the actor, not the classifier.

`EVENT_TYPES` remains unchanged in GM-24 (per OQ-24.9 — the
review-decisions table IS the artifact; an audit row is
redundant). The GM-18 lock holds; adversarial test F11 asserts
no new vocabulary slipped in. Snapshot tests C2/C3/C4 catch the
vocabulary widening at +1 each (REASONS 12 values; INTENT_TYPES
9 values; OUTCOMES 5 values).

**Constitutional rule** (added in GM-24, applies to every future
GM): *approval is not authorization; authorization is not
execution.* Recording a review outcome is a governance artifact
only. No production code consumes `governance_review_decisions`
operationally in GM-24. A future execution capability requires
its own decision gate, its own boundary guard, and its own
adversarial review.

See `review-decision-runtime-boundary.md` for the substrate
contract and `actor-runtime-boundary.md` §4b for the actor's
seventh layer (admin-only role check).

## 6a. First actor lands (GM-22)

GM-22 introduces `src/actors/` — the first code outside
`src/governance/` to consume a Decision and act on it. The first
actor (response-delivery) wraps the GM-20 conversation runtime;
it requires a classifier-produced Decision (verified via
`instanceof Decision` + `isValidDecision` + frozen + intent-type
match + structural revalidation) and refuses to call the runtime
on any non-admissible outcome. See `actor-runtime-boundary.md`
for the locked contract.

GM-22 also extends this module with one minimum-scope addition:
`isValidDecision(value)` — a WeakSet-membership check exported
from `src/governance/index.js`. The internal `_BLESSED` WeakSet
in `decisions.js` is populated by `_createDecision` and consulted
by `isValidDecision`. This closes the prototype-tampering gap
that pure `instanceof` cannot close (an attacker can call
`Object.setPrototypeOf(fake, Decision.prototype)`; the WeakSet
check rejects the result because it was never added by the
classifier's path).

## 7. Boundary guard

`scripts/ci/check-governance-boundary.js` scans `src/governance/`
only and fails the build on:

| Rule | Why |
|---|---|
| Any forbidden SQL keyword (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`/`SELECT`/`FROM`/`JOIN`/`WHERE`) | The classifier touches no SQL. |
| The identifier `insertPrivateMemory` | Defense in depth — the classifier may not call a memory-mutation op. |
| Import of `pg` | No DB. |
| Import of any model SDK (`@anthropic-ai/sdk`, `openai`, `@anthropic-ai/*`, `@openai/*`, etc.) | The classifier is pure; it does not call a model. |
| Import of `http`, `https`, `express`, `fastify`, `koa`, `@hapi/hapi` | No HTTP. |
| Import of `child_process`, `worker_threads`, `cluster` (or their `node:` forms) | No subprocess, no worker thread. |
| Import from any other `src/` layer (`../memory`, `../companion`, `../conversation`, `../runtime`, `../db`, `../setup`) | The governance module is a leaf. |
| Scheduling / async-execution identifiers: `setTimeout`, `setInterval`, `setImmediate`, `cron`, `schedule` | The classifier is sync. (Unlike the conversation guard, `setTimeout` is also banned — the classifier has no need for it.) |
| Streaming or tool-calling identifiers: `.stream(`, `messages.stream`, `stream: true`, `tools`, `tool_choice`, `tool_use`, `tool_result` | Defense in depth — the classifier is not an SDK caller. |
| `fs.writeFile*`, `fs.appendFile*`, `fs.createWriteStream`, `fs.mkdir*`, `fs.rm*`, `fs.unlink*` | No filesystem writes. |

## 8. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| Classifier executes anything | Pure function; boundary guard bans every I/O surface (pg, HTTP, fs writes, subprocess, worker thread, model SDK, scheduling). |
| Classifier reads / writes the DB | Boundary guard bans `pg` and cross-layer imports. |
| Classifier calls a model | Boundary guard bans every model SDK by name. |
| Classifier has side effects via logger | Sentinel-content unit test asserts no payload/evidence sentinel appears in stdout when classifying. The optional governance logger emits only typed metadata; callers use it explicitly, not the classifier. |
| Caller forges a Decision | Decision constructor requires a module-private Symbol token (`_TOKEN`) that external code cannot reach. Unit test asserts external `new Decision(...)` throws. |
| Caller bypasses the classifier and acts on raw intent | Future actor modules require a `Decision` instance (mechanical at the actor's boundary guard, future GM). GM-21 documents the convention in §6. |
| Classifier becomes stateful | No module-scope mutable state; review-enforced. Unit test asserts identical outputs across N calls. |
| `AI_INFERRED` memory candidate self-promotes | Classifier returns `requires_review`, never `admissible`. |
| `VERIFIED_FACT` memory candidate originates from model output | Classifier returns `inadmissible` with `verified_fact_self_promotion_forbidden`. |
| Visibility promotion happens automatically | Classifier returns `inadmissible` unconditionally for `memory.visibility.promote` in GM-21. |
| Memory retraction / supersession happen automatically | Classifier returns `inadmissible` unconditionally. |
| Vault session opens automatically | Classifier returns `inadmissible` unconditionally for `vault.session.open` in GM-21. |
| External side effects happen at all | Classifier returns `inadmissible` for `external.side_effect`; default-deny catches every unknown intent type. |
| New intent type added without policy update | Adding to `INTENT_TYPES` requires a paired classifier branch and a paired update to this document; coverage unit test asserts every `INTENT_TYPES` value has a non-default-deny classifier branch. |
| New REASON added without policy citation | `Decision` constructor validates `reason ∈ REASONS`; `policyRef` is looked up from `POLICY_REFS` — adding a REASON without a POLICY_REFS entry results in `policyRef === undefined`, which the integrity unit test catches. |
| Decisions persist anywhere in GM-21 | GM-21 has no DB access; no audit event_type is added; the GM-18 lock on `EVENT_TYPES` is unchanged. |

## 9. Audit-decision shape (forward-looking)

GM-21 produces Decisions as **return values only**. Persistence
is deferred — adding a `governance.intent.classified` (or
similar) audit `event_type` requires a paired update to
`src/memory/audit.js` `EVENT_TYPES` (GM-18 OQ-18.3 lock) AND
this document AND `decisions.js`.

When a future GM introduces persistence, the audit row shape will
carry:

| Field | Source |
|---|---|
| `event_type` | NEW `EVENT_TYPES.GOVERNANCE_INTENT_CLASSIFIED` (or similar) |
| `intent_type` | `decision.intentType` |
| (decision) | `decision.decision` (stored in `outcome` or a new field) |
| (reason) | `decision.reason` (stored in `reason` — existing column) |
| `actor_user_id` | session context (the user the actor is operating on behalf of) |
| `actor_role` | session context |
| `pilot_instance_id` | session context |
| `created_at` | wall clock at persist time |

The classifier does **none** of this in GM-21. It only returns
the Decision data; the future actor decides what to do with it.

## 10. Logging hygiene

The governance module's logger (`src/governance/log.js`) is a
sibling of `src/runtime/log.js`, `scripts/setup/log.js`,
`src/companion/log.js`, and `src/conversation/log.js`. Same
JSON-line shape, same reserved core fields, same forbidden-field
rules.

The classifier itself does **not** log. The logger is provided
for future callers who want to emit
`governance.intent.classified` events at decision time — without
content, without payload, without evidence.

## 11. Enforcement

| Property | Enforced by |
|---|---|
| SQL keyword + identifier bans in `src/governance/` | `check-governance-boundary.js` (CI) |
| `pg` / model-SDK / HTTP-framework / process-spawn / scheduling import bans | `check-governance-boundary.js` (CI) |
| Cross-layer import bans (no `../memory`, `../companion`, etc.) | `check-governance-boundary.js` (CI) |
| Streaming / tool-calling / fs-write identifier bans | `check-governance-boundary.js` (CI) |
| Classifier is pure, deterministic, total, side-effect-free | `tests/governance/classifier.test.js` (unit) |
| Decision is opaque, frozen, carries only typed metadata | `tests/governance/classifier.test.js` (unit) |
| Every `INTENT_TYPES` value has a classifier branch | `tests/governance/classifier.test.js` (coverage test) |
| Every classifier branch produces a REASONS-vocabulary reason with a non-empty `policyRef` | `tests/governance/classifier.test.js` (integrity test) |
| Sentinel content in `intent.payload` and `intent.evidence` never appears in the Decision or in stdout | `tests/governance/classifier.test.js` (privacy test) |
| `_createDecision` is not re-exported through `src/governance/index.js` | `tests/governance/classifier.test.js` (surface test) |

## 12. Change control

Adding a new intent type, a new outcome, a new REASON, or
relaxing the boundary guard is a boundary change. It requires a
reviewed change to this document **and**
`src/governance/intents.js` **and** `src/governance/decisions.js`
**and** `src/governance/classifier.js`, in the same PR. When the
new intent type touches memory or vault behavior, the same PR
must update `source-of-truth-memory-policy.md` with the paired
citation.

Mounting the classifier from a process, introducing an actor
module that consumes Decisions, or persisting decisions is its
own decision gate — future GM with its own OQ set.

## Cross-references

- `source-of-truth-memory-policy.md` — the locked policy a
  subset of which the classifier mechanically enforces (§2, §3,
  §4, §5, §6, §7, §11, §12, §13).
- `conversation-runtime-boundary.md` — the single-shot model
  runtime that produces the responses callers will classify.
- `companion-runtime-boundary.md` — the read-only consumer
  beneath conversation (orthogonal to governance).
- `memory-runtime-boundary.md` — the audit-bundled data layer
  (orthogonal to governance).
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-governance-boundary.js` — the guard.
- `../../src/governance/` — the module.
- `../../tests/governance/classifier.test.js` — the contract
  proof.
