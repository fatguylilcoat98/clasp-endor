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

Eighteen baseline CI jobs gate every PR (GM-30 adds the
gauntlet boundary guard):

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
- The **actors boundary guard** (GM-22 through GM-29) — scopes `src/actors/`;
  zero SQL keywords; bans `pg`, every model SDK (incl. `@anthropic-ai/sdk`),
  HTTP/server frameworks, `child_process`/`worker_threads`/`cluster`,
  `setInterval`/`setImmediate`/`cron`/`schedule`, all `fs` write API,
  streaming + tool-calling identifiers; rejects cross-layer imports of
  `../runtime`/`../db`/`../setup`/`../memory`/`../companion`; restricts
  `../governance`, `../conversation`, and `../review` imports to their
  public entries.
- The **review boundary guard** (GM-23 through GM-29) — scopes
  `src/review/`; bans `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`
  (`INSERT` is permitted but tracked); FROM/JOIN allowlist limited
  to the **seven** governance-staging tables + `users` + `pilot_instances`;
  INSERT INTO allowlist limited to the seven governance-staging
  tables; `pg` import scoped to `src/review/client.js`; every model
  SDK, HTTP framework, `child_process`/`worker_threads`/`cluster`,
  scheduling identifiers, `fs` write API, streaming + tool-calling
  identifiers, and the `insertPrivateMemory` identifier are
  forbidden. **Four file-scoped forbidden-vocabulary scans**
  (refactored into a shared helper per OQ-27.17): GM-26 bans
  `executed`/`completed`/`dispatched`/`delivered`/`finalized`/
  `succeeded`/`failed` in `src/actors/execution-claim-ledger-actor.js`
  (claim is NOT execution); GM-27 bans the same seven words **plus
  `committed`** in `src/actors/execution-attempt-ledger-actor.js`
  (ATTEMPT IS NOT OUTCOME); GM-28 bans the same eight words **plus
  ten truth-claim words** (`verified`/`confirmed`/`actual`/
  `actually`/`definitely`/`proven`/`certain`/`real`/`reality`/
  `truth`) in `src/actors/execution-outcome-ledger-actor.js` —
  18 words (AN OUTCOME ROW IS NOT TRUTH; the recorded outcome
  is REPORTED, not VERIFIED; `reported_completed` ≠
  `verified_completed`); GM-29 bans a DIFFERENT shape of 20
  words — 12 operational/repair (`executed`/`dispatched`/
  `retry`/`retried`/`reconcile`/`reconciled`/`rollback`/
  `compensate`/`side_effect`/`mutate`/`promote`/`admit`) + 8
  fix-it temptation (`fix`/`repair`/`correct`/`heal`/
  `resolve`/`revert`/`undo`/`apply`) in
  `src/actors/execution-verification-ledger-actor.js`, with
  bare `execute` and `dispatch` deliberately omitted to avoid
  colliding with the actor contract method name. **verification ≠ reconciliation ≠ repair.**
- The **configuration contract** (`ajv` against
  `companion.schema.json`; positive no-leak fixtures).
- Runtime + memory + companion + conversation + governance + actors
  + review **unit tests** (`node:test`, `tests/runtime/*.test.js` +
  `tests/memory/*.test.js` + `tests/companion/*.test.js` +
  `tests/conversation/*.test.js` + `tests/governance/*.test.js` —
  including the GM-22 + GM-23 + GM-24 + GM-25 adversarial
  negative-test suite at `tests/governance/adversarial.test.js`
  + `tests/actors/*.test.js` + `tests/review/*.test.js`.
- **Integration tests** (Postgres 16 service container,
  `--test-concurrency=1`) — boot scenarios, provisioning, GM-16
  RLS engagement, the GM-17 memory-governance matrix, the GM-19
  companion-read matrix, the GM-20 conversation-mounted matrix
  (the latter injects a mocked Anthropic SDK and asserts exactly
  one model call per `respond()`), the GM-23 review-queue matrix,
  the GM-24 review-decision matrix, and the GM-25 execution-
  authorization matrix (proves admin authorizes / non-admin
  denied / self-authorization trigger / rejected-review trigger /
  scope-mismatch trigger / double-authorization UNIQUE /
  cross-pilot composite-FK rejection / append-only trigger /
  GRANT denial for runtime). GM-21 and GM-22 add no integration
  test — both the classifier and the response-delivery actor are
  pure / unit-tested with mocked dependencies.
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
| Review-decision substrate (GM-24) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + a third Decision-gated actor (`src/actors/review-decision-actor.js`); not mounted by boot. `db/migrations/009_review_decisions.sql` adds `governance_review_decisions` with `reviewer_role` CHECK-locked to `'admin'`, `review_outcome` CHECK in `('approved','rejected')`, `review_reason` CHECK in a 5-value vocabulary, `UNIQUE(review_queue_id)`, BEFORE-UPDATE-OR-DELETE append-only trigger, and BEFORE-INSERT self-review trigger. Three RLS policies: insert_admin (admin-only WITH CHECK + tenant + no impersonation), admin SELECT, proposer SELECT. `lylo_app` gets SELECT + INSERT only — no UPDATE/DELETE grants; `lylo_admin` gets SELECT; `lylo_runtime`/`lylo_setup` have no grants. `createReviewDecisionActor({reviewQueuePool, log?})` inherits the GM-22/23 verification chain and adds a seventh, actor-specific layer: `params.userRole === 'admin'`. New ctx ops: `listPendingReviewItems`, `inspectReviewItem`, `recordReviewDecision`. Classifier widened by exactly one intent (`governance.review.decide`), one reason (`review_decision_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to five values (`recorded` added). EVENT_TYPES unchanged (the new table IS the artifact). Boundary guard extended for the new table; adversarial suite F-series (F1–F12) covers forged Decisions, prototype tampering, wrong intent, non-admin role, vocabulary drift, sentinel leakage, EVENT_TYPES lock. RLS contract suites extended in both synthetic and real-schema modes. New `tests/integration/review-decision.test.js` proves end-to-end. **Constitutional rule: recording a review outcome is NOT execution; approval is NOT authorization.** No production consumer of `governance_review_decisions`; future execution capability is a separately gated decision. | `governance/review-decision-runtime-boundary.md`, `db/migrations/009_review_decisions.sql`, `tests/integration/review-decision.test.js`, `tests/actors/review-decision-actor.test.js`, `tests/governance/adversarial.test.js` |
| Execution-authorization substrate (GM-25) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + a fourth Decision-gated actor (`src/actors/execution-authorization-actor.js`); not mounted by boot. `db/migrations/010_execution_authorizations.sql` adds `governance_execution_authorizations` with `authorized_by_role` CHECK-locked to `'admin'`, `authorization_scope` CHECK in a 4-value vocabulary (`memory_candidate_admission` + 3 `future_*` forward-looking values), `authorization_reason` CHECK in 1-value vocabulary (`admin_explicit_authorization`), `UNIQUE(review_decision_id)` for replay prevention, BEFORE-UPDATE-OR-DELETE append-only trigger, and a **BEFORE-INSERT preconditions trigger** that walks the chain authorization → review_decision → review_queue and refuses if (a) the referenced review_decision doesn't exist, (b) review_outcome ≠ 'approved', (c) authorizer = reviewer (self-authorization forbidden), or (d) the authorization_scope doesn't match the underlying intent type. Two RLS policies: `auth_insert_admin` (admin-only WITH CHECK + tenant + no impersonation), `auth_admin_select` (admin-only SELECT — no proposer/reviewer/family/caregiver/runtime visibility). `lylo_app` gets SELECT + INSERT; `lylo_admin` gets SELECT; `lylo_runtime`/`lylo_setup` have no grants. `createExecutionAuthorizationActor({reviewQueuePool, log?})` inherits the GM-22/23/24 verification chain and adds two actor-specific layers (admin-only role + vocabulary locks). New ctx ops: `recordExecutionAuthorization`, `listExecutionAuthorizations`, `inspectExecutionAuthorization`. Classifier widened by exactly one intent (`governance.execution.authorize`), one reason (`execution_authorization_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to six values (`authorized_recorded` added). EVENT_TYPES unchanged. Two new locked vocabularies: AUTHORIZATION_SCOPES (4 values) + AUTHORIZATION_REASONS (1 value). Adversarial G-series (G1–G13) covers forged Decisions, prototype tampering, wrong intent, non-admin role, vocabulary drift, sentinel leakage, EVENT_TYPES lock, AND **G13 = static-scan canary** that asserts zero references to the new table outside the documented writing path. RLS contract suites extended in both synthetic and real-schema modes (fixtures gained a second admin per pilot, per OQ-25.14). New `tests/integration/execution-authorization.test.js` proves end-to-end. **Constitutional rule: approval is NOT authorization; authorization is NOT execution; an authorization row is NOT an execution signal.** No production consumer; future execution capability is a separately gated decision with its own boundary guard, adversarial review, and explicit semantics for revocation/expiry/replay (none of which exist in GM-25). | `governance/execution-authorization-runtime-boundary.md`, `db/migrations/010_execution_authorizations.sql`, `tests/integration/execution-authorization.test.js`, `tests/actors/execution-authorization-actor.test.js`, `tests/governance/adversarial.test.js` |
| Execution-claim substrate (GM-26) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + a fifth Decision-gated actor (`src/actors/execution-claim-ledger-actor.js` — "ledger" in the filename per OQ-26.13 makes the read-only nature visible); not mounted by boot. `db/migrations/011_execution_claims.sql` adds `governance_execution_claims` with `claimed_by_role` CHECK-locked to `'admin'`, `authorization_scope` mirroring GM-25's 4-value vocab, `execution_surface` CHECK in a NEW 4-value vocabulary with mandatory `future_*` prefix, `UNIQUE(execution_authorization_id)` as the **replay-prevention wall**, BEFORE-UPDATE-OR-DELETE append-only trigger, and a **BEFORE-INSERT preconditions trigger** that walks authorization → review_decision and refuses if (a) the authorization doesn't exist, (b) scope drift (claim's scope ≠ authorization's), (c) claimant = authorizer (self-claim forbidden), (d) execution_surface doesn't fit authorization_scope (1:1 mapping), or (e) underlying review_outcome ≠ 'approved'. Two RLS policies: `claim_insert_admin` (admin-only WITH CHECK + tenant + no impersonation), `claim_admin_select` (admin-only SELECT). `lylo_app` gets SELECT + INSERT; `lylo_admin` gets SELECT; `lylo_runtime`/`lylo_setup` have no grants. `createExecutionClaimLedgerActor({reviewQueuePool, log?})` inherits the GM-22/23/24/25 chain and adds dual vocabulary locks. New ctx ops: `recordExecutionClaim`, `listExecutionClaims`, `inspectExecutionClaim`. Classifier widened by exactly one intent (`governance.execution.claim`), one reason (`execution_claim_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to seven values (`claim_recorded` added). EVENT_TYPES unchanged. One new locked vocabulary: EXECUTION_SURFACES (4 values, all `future_*` prefixed). Adversarial H-series (H1–H28) covers forged Decisions, prototype tampering, wrong intent, non-admin role, vocabulary drift, sentinel leakage, EVENT_TYPES lock, **H22 = static-scan canary** (zero references outside writing path), **H27 = `future_*` prefix discipline snapshot**, **H28 = file-scoped forbidden-vocabulary scan on the ledger actor file** (enforcing the OQ-26.14 boundary-guard extension). RLS contract suites extended in both synthetic and real-schema modes (fixtures gained a third admin per pilot, per OQ-26.15). New `tests/integration/execution-claim.test.js` proves end-to-end. **Constitutional rule: claim is NOT execution; claim is NOT dispatch; claim is NOT completion; claim is NOT success — claim ONLY means "this authorization has now been consumed exactly once."** No production consumer; future execution capability is a separately gated decision with explicit semantics for revocation/expiry/partial-consumption/rollback (none of which exist in GM-26). | `governance/execution-claim-runtime-boundary.md`, `db/migrations/011_execution_claims.sql`, `tests/integration/execution-claim.test.js`, `tests/actors/execution-claim-ledger-actor.test.js`, `tests/governance/adversarial.test.js` |
| Execution-attempt substrate (GM-27) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + a sixth Decision-gated actor (`src/actors/execution-attempt-ledger-actor.js` — "ledger" in the filename per OQ-27.13 is MANDATORY); not mounted by boot. `db/migrations/012_execution_attempts.sql` adds `governance_execution_attempts` with `attempted_by_role` CHECK-locked to `'admin'`, `authorization_scope` inheriting GM-25's vocab, `execution_surface` inheriting GM-26's vocab (all `future_*`), `UNIQUE(execution_claim_id)` forbidding retry / multi-attempt, BEFORE-UPDATE-OR-DELETE append-only trigger, and a **BEFORE-INSERT preconditions trigger** that walks the 5-deep chain attempt → claim → authorization → review_decision and refuses on missing claim / scope drift from claim / surface drift from claim / self-attempt (attempter = claimant) / chain rot (review no longer approved). Two RLS policies. Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`. `createExecutionAttemptLedgerActor({reviewQueuePool, log?})` inherits the GM-22/23/24/25/26 chain. New ctx ops: `recordExecutionAttempt`, `listExecutionAttempts`, `inspectExecutionAttempt`. Classifier widened by exactly one intent (`governance.execution.attempt`), one reason (`execution_attempt_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to eight values (`attempt_recorded` added). EVENT_TYPES unchanged. **NO new locked vocabularies** (inherits AUTHORIZATION_SCOPES + EXECUTION_SURFACES). Adversarial I-series (I1–I27) covers forged Decisions, prototype tampering, wrong intent, non-admin role, vocabulary drift, sentinel leakage, EVENT_TYPES lock, **I23 = static-scan canary** (zero references outside writing path), **I24 = file-scoped forbidden-vocabulary scan on the ledger actor file** (STRICTER than H28 — adds `committed`), **I27 = doc-presence canary** asserting both required sections remain in the boundary doc. Boundary guard's file-scoped scan logic refactored into shared `runFileScopedForbiddenScan` helper (per OQ-27.17). RLS contract suites extended (fixtures gained admin4-A/admin4-B per OQ-27.15). New `tests/integration/execution-attempt.test.js` proves end-to-end. **Constitutional rule: ATTEMPT IS NOT OUTCOME.** An attempt row records ONLY the beginning of an attempt — never success, failure, completion, interruption, delivery, dispatch, finalization, or commit state. No production consumer; the future-outcome GM must explicitly answer the eight unresolved questions enumerated in `docs/governance/execution-attempt-runtime-boundary.md` "What remains unresolved" (phantom attempts, time windows, pre-outcome-GM rows, missing-outcome semantics, retry semantics, verification semantics, truth claims, reconciliation). | `governance/execution-attempt-runtime-boundary.md`, `db/migrations/012_execution_attempts.sql`, `tests/integration/execution-attempt.test.js`, `tests/actors/execution-attempt-ledger-actor.test.js`, `tests/governance/adversarial.test.js` |
| Execution-outcome substrate (GM-28) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + a seventh Decision-gated actor (`src/actors/execution-outcome-ledger-actor.js` — "ledger" in the filename per OQ-28.13 is MANDATORY); not mounted by boot. `db/migrations/013_execution_outcomes.sql` adds `governance_execution_outcomes` with `recorded_by_role` CHECK-locked to `'admin'`, `authorization_scope` inheriting GM-25's vocab, `execution_surface` inheriting GM-26's vocab (all `future_*`), **`outcome_type` CHECK locked to exactly four `reported_*` observational values** (`reported_completed`, `reported_interrupted`, `reported_abandoned`, `reported_unknown`), `UNIQUE(execution_attempt_id)` forbidding replay (one outcome per attempt at most), BEFORE-UPDATE-OR-DELETE append-only trigger, and a **BEFORE-INSERT preconditions trigger** that walks the 6-deep chain outcome → attempt → claim → authorization → review_decision and refuses on missing attempt / scope drift from attempt / surface drift from attempt / self-recording (recorder = attempter) / chain rot (review no longer approved). Two RLS policies. Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`. `createExecutionOutcomeLedgerActor({reviewQueuePool, log?})` inherits the GM-22/23/24/25/26/27 chain and adds a vocabulary precondition (`VALID_EXECUTION_OUTCOME_TYPES`). New ctx ops: `recordExecutionOutcome`, `listExecutionOutcomes`, `inspectExecutionOutcome`. Classifier widened by exactly one intent (`governance.execution.outcome.record`), one reason (`execution_outcome_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to nine values (`outcome_recorded` added). EVENT_TYPES unchanged. ONE new locked vocabulary: EXECUTION_OUTCOME_TYPES (4 values, all `reported_*` prefixed — the constitutional defense against truth-claim drift). Adversarial J-series (J1, J2, J3, J5, J14, J15, J22, J24, J27, J37) covers forged Decisions, prototype tampering, wrong intent, non-admin role, sentinel leakage, EVENT_TYPES lock, **J22 = static-scan canary** (zero references outside writing path), **J24 = file-scoped forbidden-vocabulary scan on the ledger actor file** — 18 words (GM-27's 8 outcome-implying words PLUS 10 truth-claim words: `verified`/`confirmed`/`actual`/`actually`/`definitely`/`proven`/`certain`/`real`/`reality`/`truth`), **J27 = doc-presence canary** asserting both required sections remain in the boundary doc, **J37 = `EXECUTION_OUTCOME_TYPES` snapshot** asserting exactly 4 values all `reported_*` prefixed. RLS contract suites extended (fixtures gained admin5-A/admin5-B per OQ-28.15 and seeded outcomes OUTCOME_A `reported_completed` + OUTCOME_B `reported_unknown`). New `tests/integration/execution-outcome.test.js` proves end-to-end. **Constitutional rule: AN OUTCOME ROW IS NOT TRUTH.** `reported_completed` ≠ `verified_completed`; the `reported_*` prefix is a constitutional boundary, not a naming style. Outcomes are OPTIONAL — absence of an outcome row is NOT itself an outcome. No production consumer; the future-verification GM must explicitly answer the ten unresolved questions enumerated in `docs/governance/execution-outcome-runtime-boundary.md` "What remains unresolved" (verification ring, missing-outcome semantics, time windows, disagreeing observations, reconciliation with external state, aggregate use, backfill of pre-GM-28 attempts, pre-verification-GM rows, outcome revisions, privacy boundary). | `governance/execution-outcome-runtime-boundary.md`, `db/migrations/013_execution_outcomes.sql`, `tests/integration/execution-outcome.test.js`, `tests/actors/execution-outcome-ledger-actor.test.js`, `tests/governance/adversarial.test.js` |
| Execution-verification substrate (GM-29) | Landed as a library extension (`src/review/repository.js` + `src/review/transaction.js`) + an eighth Decision-gated actor (`src/actors/execution-verification-ledger-actor.js` — "ledger" in the filename per OQ-29.9 is MANDATORY); not mounted by boot. `db/migrations/014_execution_verifications.sql` adds `governance_execution_verifications` with `verified_by_role` CHECK-locked to `'admin'`, **`verification_type` CHECK locked to four channel values** (`human_observation`, `system_log_review`, `database_state_check`, `external_confirmation`), **`verification_result` CHECK locked to three values** (`verified_consistent`, `verified_inconsistent`, `verification_inconclusive`), `UNIQUE(execution_outcome_id)` forbidding replay (one verification per outcome at most), BEFORE-UPDATE-OR-DELETE append-only trigger, and a **BEFORE-INSERT preconditions trigger** that walks the 7-deep chain verification → outcome → attempt → claim → authorization → review_decision and refuses on missing outcome / self-verification (verifier = recorder) / chain rot. NO `verification_basis` column (per OQ-29.3(d) + constitutional addendum 7 — GM-29 stores governance metadata only, no evidence payloads). Two RLS policies. Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`. `createExecutionVerificationLedgerActor({reviewQueuePool, log?})` inherits the GM-22/23/24/25/26/27/28 chain and adds two vocabulary preconditions. New ctx ops: `recordExecutionVerification`, `listExecutionVerifications`, `inspectExecutionVerification`. Classifier widened by exactly one intent (`governance.execution.verify`), one reason (`execution_verification_recording_permitted`), one POLICY_REF. `OUTCOMES` widens to ten values (`verification_recorded` added). EVENT_TYPES unchanged. TWO new locked vocabularies: VERIFICATION_TYPES (4 channel values) + VERIFICATION_RESULTS (3 values with `verified_*` constitutionally isolated to this table — K37 enforces). Adversarial K-series (K1, K2, K3, K5, K14, K15, K22, K24, K27, K37) covers forged Decisions, prototype tampering, wrong intent, non-admin role, sentinel leakage, EVENT_TYPES lock, **K22 = static-scan canary** (zero references outside writing path; continuously enforced per constitutional addendum 3), **K24 = file-scoped forbidden-vocabulary scan on the ledger actor file** — 20 words (12 operational/repair `executed`/`dispatched`/`retry`/`retried`/`reconcile`/`reconciled`/`rollback`/`compensate`/`side_effect`/`mutate`/`promote`/`admit` + 8 fix-it temptation `fix`/`repair`/`correct`/`heal`/`resolve`/`revert`/`undo`/`apply`; bare `execute` and `dispatch` deliberately omitted to avoid colliding with the actor contract method name), **K27 = doc-presence canary** asserting all four required sections (`What this is NOT`, `What remains unresolved`, `Verification is not reconciliation`, `Verification does not execute or repair`) AND the verbatim phrase `verification ≠ reconciliation ≠ repair`, **K37 = `VERIFICATION_TYPES` + `VERIFICATION_RESULTS` snapshots + `verified_*` isolation from `EXECUTION_OUTCOME_TYPES`**. Boundary guard's `FILE_SCOPED_SCANS` array now has 4 entries. RLS contract suites extended (fixtures gained admin6-A/admin6-B per OQ-29.15 and seeded verifications VERIFICATION_A `verified_consistent` + VERIFICATION_B `verification_inconclusive`). New `tests/integration/execution-verification.test.js` proves end-to-end. **Constitutional rule: VERIFICATION ≠ RECONCILIATION ≠ REPAIR.** `verified_consistent` ≠ truth; `verification_inconclusive` ≠ retry / escalate / "someone must act"; the `verified_*` prefix is constitutionally isolated to this table only. A verification row is epistemic, not authoritative. Verifications are OPTIONAL — absence of a verification row is NOT itself a verification result. No production consumer; the future-conflict-resolution / canonical-state / verification-evidence GM must explicitly answer the twelve unresolved questions enumerated in `docs/governance/execution-verification-runtime-boundary.md` "What remains unresolved" (canonical state, missing-verification semantics, disagreement between verifiers, disagreement between verifier and recorder, aggregate use, evidence storage, automated verification, time windows, revisions, cascading verification, privacy boundary, pre-canonical-GM rows). | `governance/execution-verification-runtime-boundary.md`, `db/migrations/014_execution_verifications.sql`, `tests/integration/execution-verification.test.js`, `tests/actors/execution-verification-ledger-actor.test.js`, `tests/governance/adversarial.test.js` |
| Substrate freeze + adversarial gauntlet harness (GM-30) | **First GM since the process lock that is NOT a substrate.** Library `src/gauntlet/` (8 files: index/schema/scenario/harness/fixtures/forgery/trace/result) — test-only, mechanically forbidden from being imported by any production module via `check-gauntlet-boundary.js` + reciprocal forbids in the six existing boundary guards (per OQ-30.12). The harness consumes ONLY the three public surfaces: `../governance`, `../actors`, `../review` top-level entries (no internal modules, no `pg`, no model SDK, no HTTP, no scheduler, no `fs` writes, no SQL keywords). Locked scenario schema (`SCENARIO_SCHEMA_VERSION="1.0.0"`, 12 `SCENARIO_CATEGORIES`, 6 `STEP_KINDS`, 7 `SETUP_OPS`, 5 `FORGERY_PATTERNS`, 4 `EXPECT_RESULTS`, 19 `LAYERS` after the harness-corrective patch added `db-rejection`, 9 `COUNCIL_CLASSIFICATIONS`) + locked NDJSON result schema with sentinel-scan canary L14. 12 versioned scenarios under `tests/gauntlet/scenarios/` (one per locked category) — versioned scenarios **block CI** (per OQ-30.8(a)) and run in the existing `integration-tests` job. Manual scenarios under `tests/gauntlet/manual/` are gitignored and require the explicit `GAUNTLET_MANUAL=1` environment variable (L38-enforced; the original `--manual` argv flag was replaced because `node --test` does not propagate child-process arguments). NEW `check-gauntlet-boundary.js` (fifteenth boundary guard) with the 7-word L24 forbidden-vocabulary scan (`bypass`/`skip`/`disable`/`override`/`force`/`monkeypatch`/`monkey_patch`). NEW docs `governance/substrate-freeze.md` (4 mandatory sections L27-enforced) + `governance/gauntlet-harness.md` (4 mandatory sections L27-enforced). Adversarial L-series (L14, L15, L22, L24, L27, L37, L38) covers result-sentinel scan, EVENT_TYPES freeze, **L22 = substrate-freeze canary** asserting exact counts (7 governance-staging tables, 8 Decision-gated actor factories, 19 ctx operations, 2 EVENT_TYPES — bumping any count requires a new inspection-only GM), L24 = file-scoped forbidden-vocabulary scan on `src/gauntlet/`, L27 = doc-presence canary on both new docs + the verbatim phrase, L37 = gauntlet vocabulary snapshots, L38 = manual-mode refusal. **NO new substrate, NO new actor, NO new ctx op, NO new vocabulary, NO new EVENT_TYPES, NO new migration, NO new RLS policy, NO new GRANT, NO new env var, NO new dependency.** GM-30 expands NOTHING — it freezes what exists and builds the harness to prove the substrate holds under adversarial input. The verbatim phrase **`No new substrate without an inspection-only GM`** appears in `docs/governance/substrate-freeze.md` AND in this document. Per constitutional addendum 10, GM-30 makes the system **testable**, not release-ready. | `governance/substrate-freeze.md`, `governance/gauntlet-harness.md`, `src/gauntlet/`, `tests/gauntlet/scenarios/`, `tests/gauntlet/runner.test.js`, `scripts/ci/check-gauntlet-boundary.js`, `tests/governance/adversarial.test.js` |

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

GM-24 adds the **review-decision substrate**: the first time a
human admin's review outcome (`approved` / `rejected`) can be
durably recorded against a pending queue item. Library-only; no
production consumer; admin-only INSERT WITH CHECK; UNIQUE on
review_queue_id (one review per item); BEFORE-INSERT trigger
prevents self-review. The substrate makes the constitutional
distinction mechanical: **recording a review outcome is NOT
execution; approval is NOT authorization.** No external
readiness claim — recorded approvals are governance artifacts,
not signals to act.

GM-25 adds the **execution-authorization substrate**: the first
time an admin's explicit authorization (against an approved
review_decision, by a *different* admin, with a scope matching
the original intent) can be durably recorded. Library-only; no
production consumer; admin-only INSERT WITH CHECK; UNIQUE on
review_decision_id (one authorization per review); BEFORE-INSERT
preconditions trigger walks the whole chain and refuses
self-authorization, authorization of a rejected review, or
scope-↔-intent mismatch. Two new locked vocabularies
(AUTHORIZATION_SCOPES, AUTHORIZATION_REASONS) and one new actor
outcome (`authorized_recorded`). The substrate now mechanically
preserves a **four-stage** governance chain — propose → review →
authorize → (future) execute — and refuses any future GM that
collapses the boundary by accident: adversarial G13 is a
static-scan canary that fails the build if any code outside the
documented writing path references `governance_execution_authorizations`.
**Constitutional rule: approval is NOT authorization;
authorization is NOT execution; an authorization row is NOT an
execution signal.** No readiness claim.

GM-26 adds the **execution-claim substrate**: the first time
single-consumption semantics are mechanically introduced.
`UNIQUE(execution_authorization_id)` on
`governance_execution_claims` is the replay-prevention wall —
each authorization can be claimed at most once. Library-only;
no production consumer; admin-only INSERT/SELECT; BEFORE-INSERT
preconditions trigger walks authorization → review_decision and
refuses self-claim, scope drift, surface/scope mismatch, or
upstream chain rot. One new locked vocabulary (EXECUTION_SURFACES,
4 values, all `future_*` prefixed per constitutional discipline
— H27 snapshot enforces). One new actor outcome
(`claim_recorded`). The substrate now mechanically preserves a
**five-stage** governance chain — propose → review → authorize →
claim → (future) execute. Three adversarial canaries refuse any
future GM that collapses the boundary by accident: **H22**
(static-scan canary on the table), **H27** (prefix-discipline
snapshot), and **H28** (file-scoped forbidden-vocabulary scan on
the ledger actor file, mirroring the boundary-guard mechanical
enforcement). **Constitutional rule: claim is NOT execution;
claim is NOT dispatch; claim is NOT completion; claim is NOT
success — claim ONLY means "this authorization has now been
consumed exactly once."** No readiness claim.

GM-27 adds the **execution-attempt substrate**: the FIRST
artifact in the chain that names "execution" as a thing that
could happen — and deliberately stops short of saying whether
anything actually happened. `UNIQUE(execution_claim_id)` forbids
retry / multi-attempt semantics. Library-only; no production
consumer; admin-only INSERT/SELECT; BEFORE-INSERT preconditions
trigger walks the 5-deep chain attempt → claim → authorization
→ review_decision and refuses self-attempt, scope drift, surface
drift, or chain rot. No new locked vocabulary (inherits GM-25's
AUTHORIZATION_SCOPES and GM-26's EXECUTION_SURFACES). One new
actor outcome (`attempt_recorded`). The substrate now
mechanically preserves a **six-stage** governance chain —
propose → review → authorize → claim → attempt → (future) outcome.

**ATTEMPT IS NOT OUTCOME.** This is the strictest constitutional
rule in the chain so far. Three adversarial canaries refuse any
future GM that conflates the two: **I23** (static-scan canary on
the table), **I24** (file-scoped forbidden-vocabulary scan on
the ledger actor — STRICTER than GM-26's H28: adds `committed`),
and **I27** (doc-presence canary asserting both "What this is
NOT" and "What remains unresolved" sections remain in the
boundary doc). The actor filename — `execution-attempt-ledger-actor.js`
— mandates "ledger" per OQ-27.13 to make the read-only /
record-only nature visible at the filename level. No readiness
claim.

The next dangerous step is **any consumer of
`governance_execution_attempts`**, OR any GM that introduces
outcome semantics. The latter MUST explicitly answer the eight
unresolved questions enumerated in
`docs/governance/execution-attempt-runtime-boundary.md` "What
remains unresolved": phantom attempts, time windows, pre-outcome-GM
rows, missing-outcome semantics, retry semantics, verification
semantics, truth claims, reconciliation. A silent answer to any
of them is the failure mode I27 exists to prevent.

GM-28 adds the **execution-outcome substrate**: the FIRST
artifact in the chain that names an apparent end state for an
attempt — and deliberately stops short of saying whether that
state corresponds to anything that actually occurred. Outcomes
are **OPTIONAL** (an attempt may exist forever with no outcome
row, and absence of an outcome row is NOT itself an outcome) and
**at most one per attempt** (`UNIQUE(execution_attempt_id)`).
Library-only; no production consumer; admin-only INSERT/SELECT;
BEFORE-INSERT preconditions trigger walks the 6-deep chain
outcome → attempt → claim → authorization → review_decision and
refuses self-recording, scope drift, surface drift, or chain
rot. One new locked vocabulary (EXECUTION_OUTCOME_TYPES, 4
values, **all `reported_*` prefixed** — J37 snapshot enforces).
One new actor outcome (`outcome_recorded`). The substrate now
mechanically preserves a **seven-stage** governance chain —
propose → review → authorize → claim → attempt → outcome →
(future) verify.

> **CALLOUT — the recorded outcome is REPORTED, not VERIFIED.**
> `reported_completed` ≠ `verified_completed`. The `reported_*`
> prefix puts the report-vs-verdict distinction into the data
> itself. Treating `reported_completed` as a success rate, an
> SLA signal, an effect confirmation, or anything other than
> "an admin reported observing an apparent end without obvious
> interruption" smuggles a truth claim the substrate refuses to
> make. The verification ring is a separate future GM with its
> own vocabulary, its own governance, and its own decision gate.

**AN OUTCOME ROW IS NOT TRUTH.** This is the strictest
constitutional rule in the chain so far. Four adversarial
canaries refuse any future GM that conflates the two: **J22**
(static-scan canary on the table), **J24** (file-scoped
forbidden-vocabulary scan on the ledger actor — STRICTEST in
the substrate at 18 words: GM-27's 8 outcome-implying words
plus 10 truth-claim words), **J27** (doc-presence canary
asserting both "What this is NOT" and "What remains
unresolved" sections remain in the boundary doc), and **J37**
(`EXECUTION_OUTCOME_TYPES` snapshot — exactly 4 values, all
`reported_*` prefixed). The actor filename —
`execution-outcome-ledger-actor.js` — mandates "ledger" per
OQ-28.13 to make the read-only / record-only nature visible at
the filename level. No readiness claim.

The next dangerous step is **any consumer of
`governance_execution_outcomes`**, OR any GM that introduces
verification semantics. The latter MUST explicitly answer the
ten unresolved questions enumerated in
`docs/governance/execution-outcome-runtime-boundary.md` "What
remains unresolved": verification ring, missing-outcome
semantics, time windows, disagreeing observations,
reconciliation with external state, aggregate / analytic use,
backfill of pre-GM-28 attempts, pre-verification-GM rows,
outcome revisions, privacy boundary. A silent answer to any of
them is the failure mode J27 exists to prevent.

GM-29 adds the **execution-verification substrate**: the FIRST
artifact in the chain that names "checking" as a distinct
governance act — and deliberately stops short of saying that
the check was correct, repaired anything, reconciled anything,
or had any operational consequence. Verifications are
**OPTIONAL** (an outcome may exist forever with no
verification row, and absence of a verification row is NOT
itself a verification result) and **at most one per outcome**
(`UNIQUE(execution_outcome_id)`). Library-only; no production
consumer; admin-only INSERT/SELECT; BEFORE-INSERT preconditions
trigger walks the 7-deep chain verification → outcome →
attempt → claim → authorization → review_decision and refuses
self-verification, missing-outcome reference, or chain rot.
TWO new locked vocabularies: VERIFICATION_TYPES (4 channel
values) + VERIFICATION_RESULTS (3 values with the
`verified_*` prefix **constitutionally isolated** to this
substrate — K37 snapshot enforces). One new actor outcome
(`verification_recorded`). The substrate now mechanically
preserves an **eight-stage** governance chain — propose →
review → authorize → claim → attempt → outcome → verification
→ (future) canonical state. NO `verification_basis` column;
GM-29 stores governance metadata only.

> **CALLOUT — VERIFICATION IS NOT TRUTH AND IS NOT REPAIR
> (OQ-29.18 + constitutional addendum 9).** `verified_consistent`
> ≠ "true." `verified_inconsistent` ≠ "broken — fix it."
> `verification_inconclusive` ≠ "try again." Operationalising
> any of these is a separate decision gate. The verbatim phrase
> **`verification ≠ reconciliation ≠ repair`** appears in
> `docs/governance/execution-verification-runtime-boundary.md`
> and is mechanically enforced by the K27 doc-presence canary.
> Treating `verified_consistent` as a verification rate, an SLA
> signal, a state-transition trigger, or anything other than
> "an admin independently checked the report through a named
> evidence channel and observed consistency" smuggles a truth
> claim the substrate refuses to make. The canonical-state ring
> is a separate future GM with its own vocabulary, its own
> governance, and its own decision gate.

**VERIFICATION ≠ RECONCILIATION ≠ REPAIR.** This is the
strictest constitutional rule in the chain so far. Four
adversarial canaries refuse any future GM that conflates the
three: **K22** (static-scan canary on the table — continuously
enforced per constitutional addendum 3), **K24** (file-scoped
forbidden-vocabulary scan on the ledger actor — 20 words: 12
operational/repair + 8 fix-it temptation), **K27**
(doc-presence canary asserting all four required sections AND
the verbatim `verification ≠ reconciliation ≠ repair` line
remain in the boundary doc), and **K37** (`VERIFICATION_TYPES`
+ `VERIFICATION_RESULTS` snapshots + `verified_*` isolation
from `EXECUTION_OUTCOME_TYPES`). The actor filename —
`execution-verification-ledger-actor.js` — mandates "ledger"
per OQ-29.9 to make the read-only / record-only nature visible
at the filename level. No readiness claim.

The next dangerous step is **any consumer of
`governance_execution_verifications`**, OR any GM that
introduces canonical state, conflict resolution, evidence
storage, automated verification, an aggregation surface, or a
correction primitive. Each MUST explicitly answer the twelve
unresolved questions enumerated in
`docs/governance/execution-verification-runtime-boundary.md`
"What remains unresolved": canonical state, missing-
verification semantics, disagreement between verifiers,
disagreement between verifier and recorder, aggregate use,
evidence storage, automated verification, time windows,
revisions, cascading verification, privacy boundary, pre-
canonical-GM rows. A silent answer to any of them is the
failure mode K27 exists to prevent.

GM-30 is the **first GM since the process lock that is not a
substrate**. It freezes architectural expansion at the GM-29
counts (7 governance-staging tables, 8 Decision-gated actor
factories, 19 ctx operations, 2 EVENT_TYPES, 14 INTENT_TYPES,
17 REASONS, 10 OUTCOMES, the locked `reported_*` / `verified_*`
prefix discipline) and builds the adversarial gauntlet harness
(`src/gauntlet/`, `tests/gauntlet/`) needed to prove the
substrate holds under adversarial input. The freeze is
mechanically asserted by the L22 substrate-freeze canary;
bumping any of the locked counts requires a new
inspection-only GM with its own OQ approval block.

> **SUBSTRATE FROZEN AT GM-29 (OQ-30 + constitutional
> addenda 1, 7, 8).** The seven governance-staging substrates,
> the eight Decision-gated actor factories, the nineteen ctx
> operations, the locked vocabularies, and the two
> EVENT_TYPES values are all snapshot-locked by L22 + the
> existing C2/C3/C4/J37/K37/E15-K15 canaries. The verbatim
> constitutional phrase appears in
> `docs/governance/substrate-freeze.md` and in this document:
>
> **`No new substrate without an inspection-only GM`**
>
> Per constitutional addendum 10, GM-30 makes the system
> **testable**, not release-ready. The gauntlet harness
> exists so the council can paste adversarial probes into a
> structured runner and receive typed results back. Manual
> scenarios under `tests/gauntlet/manual/` are gitignored and
> never auto-run (per L38 + the runner's `GAUNTLET_MANUAL=1`
> env-var requirement); versioned scenarios under
> `tests/gauntlet/scenarios/` block CI. Adversarial probes
> classified as `missing_architecture` open a NEW
> inspection-only GM — they do NOT open a paired-change
> patch under GM-30.

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
