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
# 1. Apply migrations to a fresh database
for f in db/migrations/0*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

# 2. Provision (fill answers.json from config/answers.example.json)
node scripts/setup/provision-instance.js --answers ./answers.json

# 3. Boot
LYLO_SHELL_MODE=true npm start
```

Observed result of the rehearsal against the merged `main` (`6be23dc`):

| Step | Observed | Contract |
|---|---|---|
| Migrations | 6 SQL files apply without error | `db/migrations/` |
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

Eleven baseline CI jobs gate every PR:

- Six stdlib-only structural guards (format, migration discipline,
  secrets, no-real-data, no-archived-SQL, contamination).
- The **runtime boundary guard** (forbidden SQL keywords, table
  allowlist, model-SDK and `pg` import scoping).
- The **configuration contract** (`ajv` against
  `companion.schema.json`; positive no-leak fixtures).
- Runtime **unit tests** (`node:test`).
- Runtime **integration tests** (Postgres 16 service container,
  `--test-concurrency=1`).
- The **RLS / privacy contract** scaffold job (still scaffold; see
  Deferred).

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
| Shutdown events + version in `/status` (GM-13) | This PR | `deployment/operator-runbook.md` §3, §4, §6 |

## What is explicitly deferred

These items remain out of scope and are blocked behind their listed
gates:

- **Memory governance runtime** — `memory_store`, `memory_vaults`,
  `memory_vault_sessions`, `governance_audit_log` are schema-present
  but runtime-absent. **Gate:** the real RLS migration (GM-15) must
  apply the contracted policies to the real schema before any code
  reads or writes these tables.
- **RLS policies on the real schema** — the synthetic contract suite
  is **ported and CI-enforced** (GM-14, `tests/rls-contract/`,
  `rls-privacy-contract.md`). The real `db/migrations/` schema is
  still RLS-free; the policies are validated in synthetic. **Gate:**
  GM-15 atomic migration that introduces the DB-role model
  (`lylo_runtime` / `lylo_app` / `lylo_setup` / `lylo_admin`),
  enables RLS on the ten client-scoped tables, and applies the
  validated policies. Also wires the runtime config loader to
  connect as `lylo_runtime` and `SET LOCAL app.*` per request.
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

The next dangerous step — the first one that crosses the runtime
boundary — is the **RLS / privacy contract suite port**, which unlocks
memory-governance extraction.

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
