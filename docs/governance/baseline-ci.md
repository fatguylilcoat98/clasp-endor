# Baseline CI

Baseline governance-enforcement CI for the golden master template. It
runs on every pull request and on push to `main`. Most checks are
standard-library-only Node guards — no application code, no database, no
network. The **configuration contract** check is the one scoped
exception (see "The ajv exception" below).

## What CI enforces today

| Guard | Script | Enforces |
|---|---|---|
| Lint / format | `check-format.js` | Final newline, no trailing whitespace, and no focused tests (`.only(`) across the authored surface, including `config/` and `src/`. |
| Migration discipline | `check-migrations.js` | Numbered `NNN_*.sql` migrations only; no duplicate numbers; no stray `.sql` outside approved locations. |
| Secret / env-file guard | `check-secrets.js` | No tracked `.env*` file except `.env.example`; `.env.example` holds blank placeholders only; no secret-shaped tokens (private-key blocks, provider key prefixes, AWS key ids, JSON web tokens) in tracked files. |
| No real-data guard | `check-no-real-data.js` | No data-export file types tracked anywhere; the `seed/` tree confined to `seed/demo/`. |
| No archived SQL guard | `check-no-archived-sql.js` | No `_archive` path anywhere — the master starts a clean migration chain. |
| Configuration contract | `check-config-schema.js` | `companion.schema.json` compiles; `additionalProperties:false` on every object schema; the contract version agrees across schema and example; `companion.example.json` validates (template mode) with identity fields blank; every `tests/config/` fixture passes or fails as expected; deployed mode accepts a filled config and rejects a blank one. |
| Contamination scanner | `check-contamination.js` | No known reference-system identifier (`Mattie`, `Sandy`, `MATTIE_SOUL`) in the scoped roots (`config/`, `scripts/validate/`, `src/`). |
| Runtime boundary guard | `check-runtime-boundary.js` | In `src/runtime/` and `src/db/`: no forbidden SQL keyword (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`); every `FROM`/`JOIN` references the locked allowlist (`pilot_instances`, `companion_profile`, `supported_person_profile`, `setup_state`); no model-SDK import (`openai`, `anthropic`, `@anthropic-ai/sdk`, `@openai/*`); `pg` is imported only by `src/db/client.js`. See `runtime-boundary.md`. |
| Memory boundary guard | `check-memory-boundary.js` | In `src/memory/` (GM-17): no forbidden SQL keyword (`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` — `INSERT` is permitted but tracked separately); every `FROM`/`JOIN` references the memory-module read allowlist (`memory_store`, `memory_vaults`, `memory_vault_sessions`, `governance_audit_log`, `circle_contacts`, `users`, `pilot_instances`); every `INSERT INTO` references the tighter write allowlist (`memory_store`, `governance_audit_log` only); no model-SDK import; `pg` is imported only by `src/memory/client.js`. See `memory-runtime-boundary.md`. |
| Companion boundary guard | `check-companion-boundary.js` | In `src/companion/` (GM-19): zero SQL keywords (including read keywords like `SELECT`/`FROM`/`JOIN`/`WHERE` — the consumer never has raw SQL); the identifier `insertPrivateMemory` is forbidden; `pg`, model-SDK, and HTTP/server framework (`http`/`https`/`express`/`fastify`/`koa`/`@hapi/hapi`) imports are forbidden; memory-module imports are restricted to the public entry (`../memory` or `../memory/index`) — internal module paths are rejected. See `companion-runtime-boundary.md`. |
| Conversation boundary guard | `check-conversation-boundary.js` | In `src/conversation/` (GM-20): zero SQL keywords; the identifier `insertPrivateMemory` is forbidden; `pg`, HTTP/server framework, `child_process`, `worker_threads`, `cluster`, and scheduling (`setInterval`/`setImmediate`/`cron`/`schedule`) imports are forbidden; `fs` write API surface (`writeFile`/`appendFile`/`createWriteStream`/`mkdir`/`rm`/`unlink`) is forbidden; the only approved model SDK is `@anthropic-ai/sdk` (every other model SDK is rejected); memory access must go through `../companion` (public entry only) — direct `../memory` imports and `../companion/<deeper>` paths are rejected; streaming identifiers (`.stream(`, `messages.stream`, `stream: true`) and tool-calling identifiers (`tools`/`tool_choice`/`tool_use`/`tool_result`) are forbidden. See `conversation-runtime-boundary.md`. |
| Governance boundary guard | `check-governance-boundary.js` | In `src/governance/` (GM-21): zero SQL keywords; the identifier `insertPrivateMemory` is forbidden; `pg`, every model SDK (including `@anthropic-ai/sdk` — the governance module is pure-function and calls no model), HTTP/server framework, `child_process`, `worker_threads`, `cluster`, and scheduling (including `setTimeout`) imports / identifiers are forbidden; `fs` write API surface is forbidden; streaming + tool-calling identifiers are forbidden; the module is a LEAF — any import from another `src/` layer (`../memory`/`../companion`/`../conversation`/`../runtime`/`../db`/`../setup`) is rejected. See `governance-runtime-boundary.md`. |
| Actors boundary guard | `check-actors-boundary.js` | In `src/actors/` (GM-22 + GM-23): zero SQL keywords; the identifier `insertPrivateMemory` is forbidden; `pg`, every model SDK (including `@anthropic-ai/sdk` — the conversation runtime owns that boundary), HTTP/server framework, `child_process`, `worker_threads`, `cluster`, and scheduling (`setInterval`/`setImmediate`/`cron`/`schedule` — `setTimeout` permitted because the conversation runtime uses it transitively) imports / identifiers are forbidden; `fs` write API surface is forbidden; streaming + tool-calling identifiers are forbidden; cross-layer imports of `../runtime`/`../db`/`../setup`/`../memory`/`../companion` are rejected; imports of `../governance`, `../conversation`, and (GM-23) `../review` are restricted to the public entries (no `../governance/<deeper>`, `../conversation/<deeper>`, or `../review/<deeper>` paths). See `actor-runtime-boundary.md`. |
| Review-queue boundary guard | `check-review-boundary.js` | In `src/review/` (GM-23): SQL keywords `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` are forbidden (`INSERT` is permitted but tracked separately); every `FROM`/`JOIN` references the review-module read allowlist (`governance_review_queue`, `users`, `pilot_instances`); every `INSERT INTO` references the tighter write allowlist (`governance_review_queue` only); the identifier `insertPrivateMemory` is forbidden; `pg` is imported only by `src/review/client.js`; every model SDK, HTTP/server framework, `child_process`/`worker_threads`/`cluster`, scheduling identifiers, `fs` write API surface, streaming + tool-calling identifiers are forbidden; cross-layer imports of `../runtime`/`../db`/`../setup`/`../memory`/`../companion`/`../conversation`/`../governance`/`../actors` are rejected. See `review-queue-runtime-boundary.md`. |
| RLS / privacy contract | `tests/rls-contract/run-contract.js` + `tests/rls-contract/run-real.test.js` | RLS / privacy contract, two suites run serially in the same CI job: (1) **synthetic** — applies a generic schema, the candidate policies, and two-pilot fixtures to a throwaway Postgres; (2) **real-schema** (GM-15) — applies `db/migrations/0*.sql` (now including `008_review_queue.sql`) and the same fixtures, then runs the matrix against the real schema. Both suites assert the visibility / write matrix (cross-pilot isolation, memory-store rules per visibility level, vault-session row-state model, admin denial on private memories, default-deny, and — GM-23 — the review-queue insert/proposer/admin policies, impersonation rejection, append-only enforcement). See `rls-privacy-contract.md`. |

All fourteen guards plus the RLS / privacy contract are
**enforced** — a violation fails the build.

## Runtime tests

- The **`unit-tests`** job runs the `node:test` unit suite for the
  runtime modules under `src/runtime/` (`tests/runtime/*.test.js`),
  the memory module under `src/memory/` (`tests/memory/*.test.js`),
  the companion module under `src/companion/`
  (`tests/companion/*.test.js`, GM-19), the conversation runtime
  under `src/conversation/` (`tests/conversation/*.test.js`, GM-20
  — the conversation runtime unit suite injects a mocked Anthropic
  SDK client), the governance classifier under `src/governance/`
  (`tests/governance/*.test.js`, GM-21 — pure-function unit tests
  plus the GM-22+GM-23 adversarial negative-test suite,
  `tests/governance/adversarial.test.js`), the actors under
  `src/actors/` (`tests/actors/*.test.js`, GM-22 + GM-23 — the
  response-delivery actor injects a mocked conversation runtime;
  the review-queue actor injects a mocked review pool), and the
  review-queue substrate library under `src/review/`
  (`tests/review/*.test.js`, GM-23 — transaction + repository
  unit tests injecting a mocked pg client). It installs
  dependencies with `npm ci`.
- The **`integration-tests`** job boots the runtime against a
  throwaway **Postgres 16 service container** and asserts the runtime
  state and health output for each seed scenario, plus the GM-16
  RLS-engagement, the GM-17 memory-governance, the GM-19
  companion-read, the GM-20 conversation-mounted, and the GM-23
  review-queue-substrate contracts (`tests/integration/*.test.js`).
  The setup step creates three LOGIN roles (`lylo_runtime_login`,
  `lylo_setup_login`, `lylo_app_login`) with the per-role
  `BYPASSRLS` posture documented in
  `../deployment/operator-runbook.md` §8.

A failing test in either job fails the build.

## The ajv exception

`check-config-schema.js` is **not** standard-library-only: it depends on
`ajv` (a pinned `devDependency`) through the shared validation core,
`scripts/validate/validate-companion-config.js`. Correct JSON Schema
draft 2020-12 validation must not be hand-rolled. This is a deliberate,
scoped exception approved for the configuration-contract check only; the
other six guards remain standard-library-only. The `config-validation`
CI job runs `npm ci` before the guard.

The validation core is shared on purpose: baseline CI uses it now, and
the runtime config loader will use the same module once it is extracted,
so the configuration contract has exactly one interpreter.

## What is scaffold / deferred

- (Nothing — the `rls-contract` job runs both the synthetic suite and
  the real-schema suite. See the table above and
  `rls-privacy-contract.md`.)

## Limitations

- The **no real-data guard** enforces *structural* rules (file types,
  `seed/` layout). It cannot decide whether a particular value is
  "real" — a guard cannot read intent. That semantic boundary is
  enforced by `../setup/template-boundaries.md` and by review.
- The **secret guard** is pattern-based defense-in-depth. It is not a
  substitute for never handling real secrets in the master template.

## Running the guards locally

```sh
node scripts/ci/check-format.js
node scripts/ci/check-migrations.js
node scripts/ci/check-secrets.js
node scripts/ci/check-no-real-data.js
node scripts/ci/check-no-archived-sql.js
node scripts/ci/check-contamination.js
node scripts/ci/check-runtime-boundary.js
node scripts/ci/check-memory-boundary.js
node scripts/ci/check-companion-boundary.js
node scripts/ci/check-conversation-boundary.js
node scripts/ci/check-governance-boundary.js
node scripts/ci/check-actors-boundary.js
node scripts/ci/check-review-boundary.js
npm ci && node scripts/ci/check-config-schema.js
```

## Promotion criteria

The `rls-contract` job runs both the synthetic suite (validates the
policies in isolation) and the real-schema suite (validates the
policies as applied by `db/migrations/007_rls_policies.sql` plus
`008_review_queue.sql`). Further changes to the policies, the
DB-role model, or the schema must keep both suites green; see
`rls-privacy-contract.md` §"Change control".
