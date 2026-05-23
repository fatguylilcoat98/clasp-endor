# Operator Runbook

The runtime is the bootable shell of the Lylo Companion master
template. It loads configuration from a Postgres database, validates
it, derives a runtime state, and exposes a small health / readiness
HTTP. It performs **no** companion behavior, **no** inference, and
**no** memory access — those are future GM milestones.

This document is for operators: how to run the runtime locally, how to
read its signals, and what to do when something is off. The locked
contract behind every rule here lives in
`../governance/runtime-boundary.md`.

## 1. Overview

**What the runtime does today**

- Parses environment variables for feature flags and connection
  details.
- (Layer-1 on) Connects to Postgres with bounded retry / backoff.
- Resolves the single pilot instance, reads the four configuration
  tables, validates the companion configuration.
- Derives one of five runtime states.
- Serves `/healthz`, `/readyz`, `/status` over plain HTTP.

**What the runtime does not do (yet)**

- No companion behavior, no conversation runtime, no LLM calls.
- No memory or vault access; no governance writes.
- No Setup Mode wizard — partial configurations cannot be repaired
  through the runtime today.
- No deployment automation; local Postgres only at this stage.

## 2. Boot states

The five runtime states. State transitions are restart-to-apply except
for the `ready` ⇄ `degraded` pair, which auto-recovers.

| State | Liveness | Readiness | Entry conditions | Operator action |
|---|---|---|---|---|
| `inert` | 200 | 503 | `LYLO_SHELL_MODE` unset or `false` | Set `LYLO_SHELL_MODE=true` and restart |
| `setup-incomplete` | 200 | 503 | Layer-1 on; `companion_profile` absent or with blank identity, or `supported_person_profile` absent | Run `scripts/setup/provision-instance.js` (see `../setup/provisioning-contract.md`). A richer iterative wizard remains a future GM. |
| `configuration-invalid` | 200 | 503 | Env malformed; DB unreachable after 4 attempts; pilot resolution failed; `companion_profile` structurally invalid | Diagnose with the log events (section 6 + section 9); fix; restart |
| `ready` | 200 | 200 | Config deployed-valid + supported-person present + DB reachable | No action; healthy |
| `degraded` | 200 | 503 | Was `ready`; the periodic DB ping failed | No action — auto-recovers to `ready` when the DB returns |

**Transitions:**

- Boot → `inert` | `setup-incomplete` | `configuration-invalid` | `ready`.
- `ready` → `degraded` (DB ping failed) → `ready` (DB recovered).
- All other transitions require a restart.

## 3. Health / readiness behavior

The runtime listens on `PORT` (default `3000`). All three endpoints
return JSON with `Content-Type: application/json` and a 10 second
`requestTimeout`.

| Endpoint | When 200 | When 503 |
|---|---|---|
| `GET /healthz` | always while the process is alive | never |
| `GET /readyz` | only in `ready` | every other state |
| `GET /status` | always while the process is alive | never (returns the current state with 200) |

- **Liveness probes** → `/healthz` (does not flap on `degraded` /
  `setup-incomplete`).
- **Readiness / traffic gating** → `/readyz` (200 = serve, 503 = don't).
- **Human diagnostics** → `/status`.

### Example responses

`/healthz`:

```json
{"status":"live"}
```

`/readyz` while `ready`:

```json
{"state":"ready","ready":true}
```

`/readyz` while `setup-incomplete`:

```json
{"state":"setup-incomplete","ready":false}
```

`/status`:

```json
{
  "state": "ready",
  "ready": true,
  "uptimeSeconds": 142,
  "version": "0.0.0",
  "flags": {
    "masterSwitch": true,
    "rlsEnforced": false,
    "setupModeEnabled": false,
    "voiceEnabled": false,
    "legacyProjectModeEnabled": false
  }
}
```

## 4. `/status` response boundaries

`/status` is intentionally low-information. It **may** include:

- `state` — one of the five runtime states.
- `ready` — boolean.
- `uptimeSeconds` — integer since boot.
- `version` — the build version (env `LYLO_VERSION` if set, else
  `package.json#version`); a non-secret string for operator visibility.
- `flags` — the feature-flag booleans only.

It **must never** include:

- Persona text, companion name, supported-person name, `preferences`.
- The database connection string or any secret.
- Raw error messages or stack traces.
- Configuration values (other than the boolean feature flags).

These rules are enforced **by construction** — the health server is
given only the state, flag booleans, and boot time, so it cannot leak
configuration content even by mistake. See
`../governance/runtime-boundary.md` sections 5 and 6.

## 5. Shutdown behavior

The runtime handles `SIGTERM` and `SIGINT` identically. Shutdown is:

- **Idempotent** — re-entering shutdown (e.g. a double `SIGTERM` from
  an orchestrator) returns the in-flight promise and does not retry
  side effects.
- **Bounded** — `healthServer.closeAllConnections()` force-drains held
  keep-alive sockets so shutdown completes promptly even if a probe is
  holding a connection. Typical shutdown latency is well under two
  seconds.
- **Fail-safe** — a shutdown rejection is logged via
  `boot.shutdown.error` and the process still exits 0 via the
  `finally` clause.

The require-main path also installs `uncaughtException` and
`unhandledRejection` handlers. They log the coarse error class
(`err.code || err.name`) and exit non-zero so the orchestrator restarts
the process.

## 6. Structured log events

Every log line is one line of JSON with four reserved core fields plus
event-specific fields.

**Core fields (always present, never overridable by caller fields):**

- `ts` — ISO 8601 timestamp, UTC.
- `level` — `info` / `warn` / `error`.
- `event` — stable, namespaced event name.
- `pid` — process id.

**Example:**

```json
{"ts":"2026-05-23T23:00:40.886Z","level":"warn","event":"db.connect.attempt_failed","pid":2027,"attempt":1,"max":4,"error_class":"ECONNREFUSED"}
```

`error_class` is `err.code || err.name || 'unknown'`. **Raw
`err.message` is never logged** because pg errors can echo the
connection string.

### Event catalog

| Event | Level | Fields | Meaning | Operator action |
|---|---|---|---|---|
| `boot.env.error` | warn | `message` | An environment variable failed to parse (one per error). | Fix the env value (section 8); restart. |
| `boot.inert` | info | — | Layer-1 master switch is off; the runtime is inert. | Set `LYLO_SHELL_MODE=true` if you intended to serve. |
| `boot.db.unreachable` | error | `attempts` | DB connect exhausted retries. | Check Postgres host/port, credentials, network. |
| `boot.pilot.resolution_failed` | error | `reason` | Zero or multiple `pilot_instances` rows, or `PILOT_INSTANCE_ID` mismatch. | Inspect `pilot_instances`; ensure exactly one row; verify the env value if pinned. |
| `boot.config.invalid` | error | — | `companion_profile` row exists but the reassembled config is structurally invalid. | Re-seed `companion_profile` from the blank-template shape (`config/companion.example.json`). |
| `boot.config.load_failed` | error | — | A DB query threw during config load. | Check Postgres health and the schema migrations. |
| `boot.state` | info | `state` | The boot-time runtime state. | None if `ready`; otherwise see the state-specific row in section 2. |
| `boot.health.listening` | info | `port` | Health server bound and listening. | None. |
| `boot.shutdown.started` | info | — | Shutdown has begun (signal received, or in-process call). | None; expect `boot.shutdown.complete` shortly. |
| `boot.shutdown.complete` | info | `durationMs` | Shutdown finished cleanly; process is about to exit 0. | None. If absent after `started`, investigate process state. |
| `runtime.dependency.lost` | warn | `state` (= `degraded`) | The post-boot DB ping failed; transitioned to `degraded`. | None for a one-off — it auto-recovers. Alert if persistent. |
| `runtime.dependency.restored` | info | `state` (= `ready`) | DB ping succeeded; back to `ready`. | None. |
| `boot.shutdown.error` | error | `error_class` | Shutdown rejected; the process still exits via `finally`. | Confirm the orchestrator received a clean exit; capture preceding events. |
| `boot.fatal` | error | `error_class` | `boot()` rejected before returning the runtime handle. | Common causes are port bind conflicts (`EADDRINUSE`) or malformed init. |
| `process.uncaught_exception` | error | `error_class` | A synchronous error escaped a handler; the process exits non-zero. | Treat as a defect; capture recent events; restart will follow. |
| `process.unhandled_rejection` | error | `error_class` | An async rejection had no handler; the process exits non-zero. | Treat as a defect; capture recent events; restart will follow. |
| `db.pool.error` | error | `error_class` | A transient backend error on an idle pool client (absorbed by the handler so the process does not crash). | None for a one-off; investigate if frequent. |
| `db.connect.attempt_failed` | warn | `attempt`, `max`, `error_class` | One failed connect attempt during boot retry. | Watch the count; the bounded retry covers brief blips. After `max` failures you will see `boot.db.unreachable`. |

## 7. Boundary guard rules

The runtime boundary is CI-enforced by
`scripts/ci/check-runtime-boundary.js`. In `src/runtime/` and
`src/db/`, the guard fails on:

- A forbidden SQL keyword in code: `INSERT`, `UPDATE`, `DELETE`,
  `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `CREATE` (comments
  excluded).
- A `FROM` / `JOIN` referencing a table outside the allowlist
  (`pilot_instances`, `companion_profile`, `supported_person_profile`,
  `setup_state`).
- A model-SDK import: `openai`, `anthropic`, `@anthropic-ai/sdk`,
  `@anthropic-ai/*`, `@openai/*`.
- A `pg` import outside `src/db/client.js`.

See `../governance/runtime-boundary.md` for the locked contract.

## 8. Local run commands

### Install

```sh
npm ci
```

### Environment

Required:

- `DATABASE_URL` — Postgres connection string. Use a placeholder
  pattern such as `postgres://USER:PASSWORD@HOST:5432/DB`. The value
  is read as an opaque string and never logged.

Layer-1 master switch:

- `LYLO_SHELL_MODE` — `true` to mount the runtime; default `false`
  (inert).

Optional:

- `PORT` — health server port; default `3000`. An invalid value yields
  `configuration-invalid`.
- `PILOT_INSTANCE_ID` — when set, must match the single
  `pilot_instances` row; mismatch yields `configuration-invalid`.
- `LYLO_VERSION` — build version override surfaced in `/status`. When
  unset, the runtime uses `package.json#version`.
- `RLS_ENFORCED` — Layer-2; independent of Layer-1; default `false`.
- `SETUP_MODE_ENABLED`, `VOICE_ENABLED`,
  `LEGACY_PROJECT_MODE_ENABLED` — Layer-3 capability sub-flags;
  defaults `false`.

### Provision the instance (first-time setup)

A fresh instance database needs the four configuration rows seeded
before the runtime can reach `ready`. Fill an answers file (start from
`config/answers.example.json`) and run the offline provisioning
script:

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
node scripts/setup/provision-instance.js --answers ./answers.json
```

The script validates the answers, seeds atomically, and records a
paper-trail in `setup_state`. Run **while the runtime is not mounted**
against the same database. See
`../setup/provisioning-contract.md` for the contract, idempotency
rules, and event catalog.

### Run

```sh
LYLO_SHELL_MODE=true \
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
npm start
```

The runtime emits JSON-line logs to stdout. Pipe through `jq` for
human reading:

```sh
LYLO_SHELL_MODE=true \
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
npm start | jq
```

### Probe

```sh
curl -s http://localhost:3000/healthz | jq
curl -s http://localhost:3000/readyz  | jq
curl -s http://localhost:3000/status  | jq
```

### Test

Unit tests (no database):

```sh
npm test
```

Integration tests (require a throwaway Postgres). Run files serially —
each `before` hook resets the schema, so concurrent files would race:

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
node --test --test-concurrency=1 tests/integration/*.test.js
```

### Guards (run individually)

```sh
node scripts/ci/check-format.js
node scripts/ci/check-migrations.js
node scripts/ci/check-secrets.js
node scripts/ci/check-no-real-data.js
node scripts/ci/check-no-archived-sql.js
node scripts/ci/check-contamination.js
node scripts/ci/check-runtime-boundary.js
npm ci && node scripts/ci/check-config-schema.js
```

## 9. Failure-mode interpretation

### `configuration-invalid`

| Event you saw | Likely cause | What to check |
|---|---|---|
| `boot.env.error` | Bad env value (e.g. non-integer `PORT`, missing `DATABASE_URL`) | Fix the env value; restart. |
| `boot.db.unreachable` | Postgres unreachable after four attempts (1 + 2 + 4 + 8 s backoff) | `pg_isready -h HOST`; firewall and routing; restart Postgres; restart the runtime. |
| `boot.pilot.resolution_failed`, reason `no pilot_instances row exists` | Database is not initialized | Apply migrations; insert exactly one `pilot_instances` row. |
| `boot.pilot.resolution_failed`, reason `expected exactly one pilot_instances row, found N` | Single-tenant invariant violated | Reduce to one pilot row; restart. |
| `boot.pilot.resolution_failed`, reason mentioning `PILOT_INSTANCE_ID` | Env pin does not match the DB row | Update the env value or the DB row to match; restart. |
| `boot.config.invalid` | The `companion_profile` JSONB columns are not a structurally complete configuration | Re-seed using the blank-template shape from `config/companion.example.json`. |
| `boot.config.load_failed` | A DB query threw during load | Inspect Postgres logs; verify the schema is at the expected migrations. |

### `setup-incomplete`

- Fresh database (no `companion_profile`, no `supported_person_profile`)
  → fill an answers file (start from `config/answers.example.json`)
  and run `scripts/setup/provision-instance.js --answers ./answers.json`.
  The script seeds all four required rows atomically and records a
  paper-trail in `setup_state`. The runtime reaches `ready` on the next
  boot. See `../setup/provisioning-contract.md`.
- Partial seed (e.g. `companion_profile` present with blank identity,
  or `supported_person_profile` absent against an existing pilot) →
  `--force` is **not** implemented for destructive reseed in this
  version. Resolve by dropping and recreating the database, re-applying
  migrations, and running the provisioning script against the fresh
  instance. A future PR may add deterministic non-destructive
  re-provisioning.

### `degraded`

- Auto-recovers when the DB returns. The dependency monitor pings
  every 15 seconds.
- Alert only if `degraded` persists across several intervals.

### `process.uncaught_exception` / `process.unhandled_rejection`

- The process exits non-zero by design. Capture the recent log lines,
  file a report, and expect orchestrator restart.

### `boot.fatal`

- `boot()` rejected before returning the runtime handle. The most
  common causes are port bind conflicts (`EADDRINUSE`) or malformed
  initialization. The `error_class` field is enough to triage.

## 10. Not yet here

Items intentionally absent from the current runtime and planned for
later GMs:

- **Setup Mode wizard** — the **one-shot offline provisioning script**
  is delivered (`scripts/setup/provision-instance.js`, see
  `../setup/provisioning-contract.md`). A richer iterative wizard with
  resumable per-step state, deterministic non-destructive
  re-provisioning (`--force`), and a UI remains a future GM milestone.
- **Companion behavior** — conversation, inference, reminders. Gated
  behind the RLS contract suite port and subsequent memory-governance
  extraction.
- **Memory governance runtime** — `memory_store`, vaults, and the
  audit log are schema-present but runtime-absent. Blocked until the
  RLS / privacy contract suite is ported and passing.
- **RLS policies** — the schema is RLS-ready; no policies exist. The
  locked contract is `tests/rls-contract/` once that port lands.
- **Deployment automation** — Render / Supabase configuration is
  intentionally absent at this stage; local Postgres only.

## Cross-references

- `../governance/runtime-boundary.md` — the locked runtime boundary
  (allowed reads, forbidden operations, logging hygiene).
- `../governance/companion-config-contract.md` — the configuration
  schema contract.
- `../governance/companion-configuration-boundary.md` — the
  platform-vs-companion boundary.
- `../governance/baseline-ci.md` — the CI guard set.
- `../governance/feature-flag-model.md` — the three-layer flag model.

## Change control

Operational notes. This document is not a contract — the contract
lives in `../governance/runtime-boundary.md`. Update this runbook
whenever an event is added, a state transitions, or a command changes.
