# Release Candidate — Runtime Shell

**Status as of GM-13:** the runtime shell of the Lylo Companion master
template is declared a **deployment-ready runtime shell**. It boots a
fresh database to a serving `/healthz` + `/readyz` + `/status`
endpoint, with structured logs throughout, in three commands.

This document records the rehearsal evidence behind that declaration,
what is in scope today, and what is explicitly deferred.

## Scope of "runtime shell"

What this release candidate *is*:

- A bootable Node process that loads configuration from a Postgres
  database, validates it against a locked JSON-Schema contract,
  derives a five-state runtime model, and exposes a small health /
  readiness HTTP.
- An offline, validated, idempotency-protected one-shot provisioning
  script that seeds a fresh instance database from an answers file.
- A CI-enforced runtime boundary that keeps the runtime read-only and
  the provisioning script out of `src/`.
- Structured JSON-line observability for every runtime and
  provisioning event, with a reserved-core-field discipline and a
  positive no-leak test.
- An operator runbook that matches the runtime byte-for-byte (state
  names, endpoint paths, status codes, response shapes, event
  catalog).

What this release candidate is **not** — see "Deferred" below.

## End-to-end rehearsal (from a fresh database)

```sh
# 1. Apply migrations to a fresh database (bootstrap superuser)
for f in db/migrations/0*.sql; do
  psql "$BOOTSTRAP_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

# 2. Create the LOGIN roles (one-time, see operator-runbook.md §8).
#    BYPASSRLS does not inherit through IN ROLE — the setup LOGIN role
#    carries it directly.
psql "$BOOTSTRAP_DATABASE_URL" -c "
  CREATE ROLE lylo_runtime_login LOGIN PASSWORD '...' IN ROLE lylo_runtime;
  CREATE ROLE lylo_setup_login   LOGIN PASSWORD '...' IN ROLE lylo_setup;
  ALTER ROLE  lylo_setup_login   BYPASSRLS;
"

# 3. Provision (fill answers.json from config/answers.example.json) as lylo_setup
LYLO_SETUP_DATABASE_URL='postgres://lylo_setup_login:.../...' \
node scripts/setup/provision-instance.js --answers ./answers.json
# The setup.pilot.created log line carries the new pilot's UUID — pin
# it on LYLO_PILOT_INSTANCE_ID for step 4.

# 4. Boot as lylo_runtime, env-first pilot identity
LYLO_SHELL_MODE=true \
LYLO_RUNTIME_DATABASE_URL='postgres://lylo_runtime_login:.../...' \
LYLO_PILOT_INSTANCE_ID='<pilot-uuid-from-step-3>' \
npm start
```

Observed result of the rehearsal against the merged `main` (`6be23dc`):

| Step | Observed | Contract |
|---|---|---|
| Migrations | 7 SQL files apply without error (001–006 baseline + 007 RLS policies) | `db/migrations/` |
| Provisioning | 7 JSON-line events from `setup.start` to `setup.complete`, with `pilot_instance_id` | `docs/setup/provisioning-contract.md` |
| Boot | reaches `ready` in ~200 ms | `docs/governance/runtime-boundary.md`, `docs/deployment/operator-runbook.md` §2 |
| `/healthz` | 200 `{"status":"live"}` | runbook §3 |
| `/readyz` | 200 `{"state":"ready","ready":true}` | runbook §3 |
| `/status` | 200 with `state` / `ready` / `uptimeSeconds` / `version` / `flags` | runbook §3 + §4 |
| Boot logs | `boot.state` (info) + `boot.health.listening` (info) — both JSON-line with `ts`/`level`/`event`/`pid` | runbook §6 |
| Shutdown (SIGTERM) | clean exit; `boot.shutdown.started` + `boot.shutdown.complete{durationMs}` emitted | runbook §5 + §6 |

The rehearsal is automated by `tests/integration/boot.test.js` and
`tests/integration/provision.test.js`; the `integration-tests` CI job
runs both against a Postgres 16 service container.

## CI enforcement

Seventeen baseline CI jobs gate every PR:

- Six stdlib-only structural guards (format, migration discipline,
  secrets, no-real-data, no-archived-SQL, contamination).
- The **runtime boundary guard** (forbidden SQL keywords, table
  allowlist, model-SDK and `pg` import scoping) — scopes
  `src/runtime/` + `src/db/`.
- The **memory boundary guard** (GM-17) — scopes `src/memory/`;
  `UPDATE`/`DELETE` banned; `INSERT` permitted on `memory_store`
  and `governance_audit_log` only; FROM/JOIN allowlist includes the
  memory + supporting tables; `pg` import scoped to
  `src/memory/client.js`.
- The **companion boundary guard** (GM-19) — scopes
  `src/companion/`; zero SQL keywords (including read keywords);
  bans `pg`, model-SDKs, HTTP/server frameworks, and the
  `insertPrivateMemory` identifier; restricts memory imports to
  the public entry only.
- The **conversation boundary guard** (GM-20) — scopes
  `src/conversation/`; zero SQL keywords; bans `pg`,
  HTTP/server frameworks, `child_process`, `worker_threads`,
  `cluster`, scheduling identifiers, and `fs` write API; the only
  approved model SDK is `@anthropic-ai/sdk`; memory access must go
  through `../companion` (public entry only); streaming
  (`.stream(`, `messages.stream`, `stream: true`) and tool-calling
  identifiers (`tools`/`tool_choice`/`tool_use`/`tool_result`) are
  forbidden.
- The **governance boundary guard** (GM-21) — scopes
  `src/governance/`; the module is a pure-function **leaf** — any
  cross-layer import (`../memory`/`../companion`/`../conversation`/
  `../runtime`/`../db`/`../setup`) is rejected; zero SQL keywords;
  every model SDK including `@anthropic-ai/sdk` is forbidden;
  scheduling (including `setTimeout`) and all `fs` write API are
  forbidden; the classifier is sync, stateless, side-effect-free.
- The **actors boundary guard** (GM-22 + GM-23) — scopes `src/actors/`;
  zero SQL keywords; bans `pg`, every model SDK (incl. `@anthropic-ai/sdk`),
  HTTP/server frameworks, `child_process`/`worker_threads`/`cluster`,
  `setInterval`/`setImmediate`/`cron`/`schedule`, all `fs` write API,
  streaming + tool-calling identifiers; rejects cross-layer imports of
  `../runtime`/`../db`/`../setup`/`../memory`/`../companion`; restricts
  `../governance`, `../conversation`, and `../review` imports to their
  public entries.
- The **review-queue boundary guard** (GM-23) — scopes `src/review/`;
  bans `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`
  (`INSERT` is permitted but tracked); FROM/JOIN allowlist limited to
  `governance_review_queue` + `users` + `pilot_instances`; INSERT INTO
  allowlist limited to `governance_review_queue`; `pg` import scoped
  to `src/review/client.js`; every model SDK, HTTP framework,
  `child_process`/`worker_threads`/`cluster`, scheduling identifiers,
  `fs` write API, streaming + tool-calling identifiers, and the
  `insertPrivateMemory` identifier are forbidden; cross-layer imports
  of `../runtime`/`../db`/`../setup`/`../memory`/`../companion`/`../conversation`/`../governance`/`../actors`
  are rejected.
- The **configuration contract** (`ajv` against
  `companion.schema.json`; positive no-leak fixtures).
- Runtime + memory + companion + conversation + governance + actors
  + review **unit tests** (`node:test`, `tests/runtime/*.test.js` +
  `tests/memory/*.test.js` + `tests/companion/*.test.js` +
  `tests/conversation/*.test.js` + `tests/governance/*.test.js` —
  including the GM-22 + GM-23 adversarial negative-test suite at
  `tests/governance/adversarial.test.js` + `tests/actors/*.test.js`
  + `tests/review/*.test.js`).
- **Integration tests** (Postgres 16 service container,
  `--test-concurrency=1`) — boot scenarios, provisioning, GM-16
  RLS engagement, the GM-17 memory-governance matrix, the GM-19
  companion-read matrix, the GM-20 conversation-mounted matrix
  (the latter injects a mocked Anthropic SDK and asserts exactly
  one model call per `respond()`), and the GM-23 review-queue
  matrix (proves cross-pilot/impersonation rejection, append-only
  trigger, role-grant denial, proposer/admin visibility). GM-21
  and GM-22 add no integration test — both the classifier and the
  response-delivery actor are pure / unit-tested with mocked
  dependencies, no DB or model dependency.
- The **RLS / privacy contract** job runs both the synthetic suite
  (`run-contract.js`) and the real-schema suite (`run-real.test.js`)
  serially against a Postgres 16 service container.

## What is in this release candidate

| Surface | Status | Document |
|---|---|---|
| Configuration contract (GM-5 JSON Schema 2020-12) | Locked | `governance/companion-config-contract.md` |
| Configuration validator (GM-6, ajv strict) | CI-enforced | `governance/baseline-ci.md` |
| Runtime configuration loader + validation hook (GM-7) | Boots; read-only against 4 tables | `deployment/operator-runbook.md` |
| Runtime boundary guard (GM-8) | CI-enforced | `governance/runtime-boundary.md` |
| Lifecycle hardening (GM-9) | Pool error handler, idempotent shutdown, request/header timeouts, fail-fast uncaught handlers | `governance/runtime-boundary.md` §5 |
| Structured JSON-line logging (GM-10) | One logger, 16-event catalog, R4 no-leak test | `governance/runtime-boundary.md` §5 |
| Operator runbook (GM-11) | Byte-accurate against the runtime | `deployment/operator-runbook.md` |
| Offline provisioning script (GM-12) | One-shot, atomic, idempotent, paper-trail | `setup/provisioning-contract.md` |
| Shutdown events + version in `/status` (GM-13) | Landed | `deployment/operator-runbook.md` §3, §4, §6 |
| Synthetic RLS / privacy contract (GM-14) | Landed; CI-enforced | `governance/rls-privacy-contract.md` |
| Real-schema RLS migration + `lylo_*` roles (GM-15) | Landed | `db/migrations/007_rls_policies.sql`, `governance/rls-privacy-contract.md` §"Runtime wire-up status" |
| RLS-engaged runtime + provisioning connection roles (GM-16) | Landed; **RLS engaged in production** via `LYLO_RUNTIME_DATABASE_URL` (lylo_runtime) and `LYLO_SETUP_DATABASE_URL` (lylo_setup); pilot identity env-first via `LYLO_PILOT_INSTANCE_ID` | `deployment/operator-runbook.md` §8, `governance/rls-privacy-contract.md` §"Runtime wire-up status", `tests/integration/rls-engagement.test.js` |
| Memory-governance runtime library (GM-17) | Landed as a library (`src/memory/`); not mounted by boot. Connects as `lylo_app` via `LYLO_APP_DATABASE_URL` (NO BYPASSRLS); audit-bundled `listVisibleMemories` + `insertPrivateMemory` only; per-transaction `app.pilot_instance_id` / `app.user_id` / `app.user_role` via `set_config`; dedicated boundary guard; 12-scenario integration matrix | `governance/memory-runtime-boundary.md`, `deployment/operator-runbook.md` §8, `tests/integration/memory-governance.test.js` |
| Memory-governance API hardening (GM-18) | Opaque `MemoryPoolHandle` (WeakMap); `MemoryRepositoryError` wraps pg errors; audit `eventType` locked to `EVENT_TYPES`; `MAX_CONTENT_LENGTH = 65536` bytes; integration scenarios 13-16 prove UPDATE/DELETE denial and end-to-end error sanitization | `governance/memory-runtime-boundary.md` §5a |
| First read-only governed consumer (GM-19) | Landed as a library (`src/companion/`); not mounted by boot. `createCompanionReader({memoryPool, log?})` returns a frozen reader with `readVisibleMemories` only; reuses `tests/rls-contract/fixtures.sql`; dedicated `check-companion-boundary.js` guard bans `pg` / SQL keywords / HTTP frameworks / model SDKs / the `insertPrivateMemory` identifier; restricts memory imports to the public entry; integration matrix proves visibility-rule parity, cross-pilot isolation, no-write invariant, exactly-one audit row per read, and `MemoryRepositoryError` shape | `governance/companion-runtime-boundary.md`, `deployment/operator-runbook.md` §8, `tests/integration/companion-read.test.js` |
| First mounted conversational runtime (GM-20) | Landed as a library (`src/conversation/`); not mounted by boot. `createConversationRuntime({companionReader, modelClient, log?, config?})` returns a frozen runtime with `respond()` only; consumes `src/companion` (public entry); first new dependency since GM-0 (`@anthropic-ai/sdk`, pinned `0.98.0`); strictly single-shot, non-streaming, no tool/function calling, no retries inside the runtime, no transcript persistence, no automatic memory creation; dedicated `check-conversation-boundary.js` guard mechanically forbids streaming, tool calling, scheduling, fs writes, HTTP frameworks, process spawning, and every model SDK other than `@anthropic-ai/sdk`; locked configuration defaults (`claude-sonnet-4-6` / `maxTokens=1024` / `temperature=0.3` / `MAX_USER_MESSAGE_BYTES=8192` / `defaultMemoryLimit=20`); deterministic exported `buildPrompt` wraps each memory row in `<<MEMORY id=… provenance=… visibility=… admissibility=…>>…<</MEMORY>>` envelopes; integration matrix (with mocked SDK) proves visibility-rule parity, cross-pilot isolation, no-write invariant, exactly-one `memory.list` audit row per `respond()`, exactly-one SDK call per `respond()`, no streaming/tool-calling fields in the SDK request, `MemoryRepositoryError` propagation; unit-suite sentinel scan proves memory content, user message, and model response never appear in captured logs | `governance/conversation-runtime-boundary.md`, `tests/integration/conversation-mounted.test.js` |
| Execution-decision classifier (GM-21) | Landed as a pure-function library (`src/governance/`); not mounted by boot. `classifyExecutionIntent({type, payload?, evidence?})` returns a frozen, opaque `Decision { intentType, decision, reason, policyRef }` that future actor modules will require by `instanceof`-check. Locked closed taxonomy: `response.deliver` (admissible), `memory.candidate.create` (per provenance — VERIFIED_FACT inadmissible, AI_INFERRED/USER_STATED requires_review), `memory.visibility.promote`/`memory.retract`/`memory.supersede`/`vault.session.open`/`vault.session.revoke`/`external.side_effect` (all inadmissible in GM-21). Default-deny on unknown intent types and malformed inputs — classifier never throws. Dedicated `check-governance-boundary.js` guard makes the module a leaf: no `pg`, no model SDK (including `@anthropic-ai/sdk`), no HTTP, no `setTimeout`/`setInterval`/scheduling, no fs writes, no cross-layer imports. No persistence; no new `EVENT_TYPES`; no boot mount; mechanically enforces a subset of `source-of-truth-memory-policy.md` (§2/§3/§4/§5/§6/§7/§12/§13). | `governance/governance-runtime-boundary.md`, `tests/governance/classifier.test.js` |
| First Decision-gated actor + adversarial review (GM-22) | Landed as a library (`src/actors/`); not mounted by boot. `createResponseDeliveryActor({conversationRuntime, log?})` returns a frozen actor with `execute(decision, params)`. Five-layer Decision verification: `instanceof Decision` + `isValidDecision` (WeakSet membership — closes prototype-tampering gap) + `Object.isFrozen` + intent-type confusion check + structural-vocabulary revalidation. Verified-but-not-admissible Decisions route to `{outcome: 'abstained' \| 'rejected', decision}`; forged or tampered Decisions throw. The conversation runtime is called exactly once on admissible paths and zero times otherwise. The GM-21 governance module is extended minimally: `_BLESSED` WeakSet inside `decisions.js` and a new `isValidDecision` export from `src/governance/index.js`. New `check-actors-boundary.js` guard; new `tests/governance/adversarial.test.js` (the project's first NEGATIVE test suite — every assertion is "this must NOT work"). EVENT_TYPES + REASONS + INTENT_TYPES snapshot tests assert no vocabulary drift. No new persistence, no new `EVENT_TYPES`, no new RLS, no boot mount, no new dependencies. | `governance/actor-runtime-boundary.md`, `tests/actors/response-delivery-actor.test.js`, `tests/governance/adversarial.test.js` |
| Review-queue substrate (GM-23) | Landed as a library (`src/review/`) + a second actor (`src/actors/review-queue-actor.js`); not mounted by boot. `db/migrations/008_review_queue.sql` adds `governance_review_queue` with CHECK constraints mirroring GM-21 INTENT_TYPES + REASONS, locked `status = 'pending_review'`, BEFORE-UPDATE-OR-DELETE trigger, and three RLS policies (insert_own / proposer SELECT / admin SELECT). `lylo_app` gets SELECT + INSERT only — no UPDATE/DELETE grants; `lylo_admin` gets SELECT; `lylo_runtime` and `lylo_setup` have no grants. `createReviewQueueActor({reviewQueuePool, log?})` inherits the GM-22 five-layer Decision verification chain and adds a sixth, actor-specific check: `decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW`. Only `requires_review` Decisions can stage; admissible / inadmissible Decisions throw. The actor returns `{outcome: 'staged', decision, queueEntryId, createdAt}` (the new `STAGED` value in the actor `OUTCOMES` enum). New `check-review-boundary.js` guard scopes `src/review/`; SQL-keyword bans, model-SDK bans, scheduling bans, fs-write bans, cross-layer-import bans. New `tests/integration/review-queue.test.js` proves the end-to-end matrix; the synthetic RLS contract suite (`run-contract.js`) and the real-schema suite (`run-real.test.js`) are extended with the review-queue scenarios. Adversarial suite extended with E-series probes. No dequeue path, no approval engine, no status transitions, no auto-action, no notifications, no boot mount, no new env, no new dependencies, no `EVENT_TYPES` widening. | `governance/review-queue-runtime-boundary.md`, `db/migrations/008_review_queue.sql`, `tests/integration/review-queue.test.js`, `tests/actors/review-queue-actor.test.js`, `tests/governance/adversarial.test.js` |

## What is explicitly deferred

These items remain out of scope and are blocked behind their listed
gates:

- **Memory governance — promotion / retraction / supersession / vault opening.**
  GM-17 landed the first audit-bundled memory surface (read +
  insert-private only). Visibility promotion (`private` →
  `family_shared`/`password_locked`), admissibility transitions,
  retraction, supersession, and vault PIN verification + session
  opening are all deferred — they need `UPDATE` grants on
  `memory_store` / `memory_vaults` or a new `WITH CHECK` INSERT
  policy on `memory_vault_sessions` that GM-15 did not include.
  **Gate:** a future GM milestone with explicit owner approval and
  the corresponding grant/policy change.
- **Companion behavior / conversation runtime / inference.** Gated
  behind the additional memory-governance ops above and explicit
  owner approval for the model-SDK introduction.
- **Companion behavior** — conversation, inference, reminders.
  **Gate:** memory-governance runtime + the RLS contract.
- **Setup Mode iterative wizard** — the one-shot provisioning script
  is delivered; an iterative / resumable / UI-driven wizard is
  deferred. **Gate:** owner decision after operator feedback on the
  one-shot path.
- **Destructive re-provisioning (`--force`)** — recognized as a flag
  but explicitly non-destructive in this version. **Gate:** a future
  PR with deterministic non-destructive behavior and tests.
- **Deployment automation** — Render / Supabase configuration is
  intentionally absent at this stage. **Gate:** separate owner
  approval; the instance database and runtime process are operator-
  managed today.
- **Authentication / authorization on the health endpoints** — none
  today; the endpoints are unauthenticated probes. **Gate:** owner
  decision when external exposure becomes a concern.
- **Metrics / tracing / log shipping** — not in scope.
- **Hot reload of configuration** — restart-to-apply is the model.
  **Gate:** owner decision.

## Declaration

With every CI job green on `main`, the documented operator path
matching observed behavior, and all hard limits held, the **runtime
shell of the master template is deployment-ready as a release
candidate**.

With GM-16 landed, the dormant GM-15 RLS policies are engaged in
production via the `lylo_runtime` and `lylo_setup` LOGIN roles.
GM-17 extracted the first **memory-governance runtime library**
under the new `lylo_app` LOGIN role: audit-bundled read + insert-
private operations, per-transaction `set_config` of the three
`app.*` session vars, a dedicated boundary guard, and the 12-
scenario integration matrix proving cross-pilot isolation,
family/admin/vault visibility rules, audit atomicity, and
`lylo_app_login` posture (no `BYPASSRLS`).

GM-23 adds the **review-queue substrate**: the first time a
`requires_review` Decision can be durably staged for later human
review. Library-only; no dequeue path, no approval engine, no
status transitions, no boot mount; the substrate and the review-
queue actor together mechanically prove that "you cannot persist
a review item without a valid `requires_review` Decision". No
external readiness claim — the substrate is a **building block**
for future human-review tooling, not an active workflow.

The next dangerous step is the **additional memory-governance ops**
that need new grants or policies: visibility promotion,
admissibility transitions, retraction, supersession, and vault PIN
verification + session opening. Each is gated on its own owner
decision. **Beyond** that lies the equally-gated build-out of the
review-queue lifecycle (dequeue, approval, status transitions,
human-review surface).

## Cross-references

- `operator-runbook.md` — the operator-facing reference for the
  runtime shell.
- `../setup/provisioning-contract.md` — the offline provisioning
  contract.
- `../governance/runtime-boundary.md` — the locked runtime boundary
  (allowed reads, forbidden operations, logging hygiene).
- `../governance/companion-config-contract.md` — the configuration
  schema contract.
- `../governance/baseline-ci.md` — the CI guard set.

## Change control

Update this file whenever the rehearsal evidence changes or items move
between "in this release candidate" and "deferred". It is a status
record, not a contract — the contracts live in `governance/`.
