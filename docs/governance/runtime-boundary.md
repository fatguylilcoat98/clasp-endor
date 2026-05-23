# Runtime Boundary

**Applies to:** the runtime configuration-loader code in `src/runtime/`
and `src/db/` — the master template's first executable surface.
**Status:** locked. Changes go through a reviewed change to this file.
**Depends on:** `companion-configuration-boundary.md`,
`companion-config-contract.md`, `governance-vocabulary-lock.md`,
`source-of-truth-memory-policy.md`.

## Purpose

GM-7b introduced the runtime configuration loader and validation hook —
the first executable code in the master. This document formalizes the
boundary that runtime obeys and turns the rules from PR-review
expectations into a permanent contract. Drift is mechanically prevented
by `scripts/ci/check-runtime-boundary.js`.

## 1. Allowed database read surface

The configuration loader reads **exactly four** tables, and reads only
through `SELECT`, `BEGIN READ ONLY`, `COMMIT`, and `ROLLBACK`
statements:

| Table | Purpose |
|---|---|
| `pilot_instances` | resolve the single pilot |
| `companion_profile` | the live, authoritative companion configuration |
| `supported_person_profile` | the supported person's durable record |
| `setup_state` | onboarding progress — **diagnostics only**, never decides `ready` |

Every loader query is **`SELECT`-only**, **parameterized** where it has
inputs, and wrapped in a **`READ ONLY` transaction**. Adding a query is
a boundary change that requires this document to be updated.

## 2. Forbidden database operations

The runtime modules must never contain a write or DDL operation.
Forbidden SQL keywords in `src/runtime/` and `src/db/` code:

- `INSERT`, `UPDATE`, `DELETE`
- `DROP`, `ALTER`, `TRUNCATE`
- `GRANT`, `REVOKE`
- `CREATE` (in any form — `CREATE TABLE`, `CREATE INDEX`,
  `CREATE FUNCTION`, etc.)

Tables outside the allowlist in section 1 — `memory_store`,
`memory_vaults`, `memory_vault_sessions`, `governance_audit_log`,
`circle_contacts`, `users`, and any conversation / inference table —
must not appear in a `FROM` or `JOIN` clause in runtime code.

## 3. Forbidden imports

- **Model SDKs** — `openai`, `anthropic`, `@anthropic-ai/sdk`, and any
  package under `@anthropic-ai/` or `@openai/`. The runtime layer
  performs no inference and orchestrates no model.
- **`pg` scope** — `pg` may be imported **only** by
  `src/db/client.js`. Any other module under `src/runtime/` or
  `src/db/` that imports `pg` is a boundary violation.

## 4. Fail-closed

Every failure path in the runtime modules lands in a non-`ready`
state. Configuration validation failures, missing required environment
variables, database unreachability, pilot-resolution failures, and
schema-version mismatches all yield `configuration-invalid` or
`setup-incomplete`. The runtime never serves companion behavior on an
unvalidated, incomplete, or guessed configuration.

## 5. Logging hygiene

Operational logs from the runtime modules may include the runtime state
and coarse error classes. They must **never** include:

- the database connection string or any secret;
- persona text, companion name, or any `companion_profile` content;
- supported-person identity or `preferences`;
- raw validation-error detail that could echo configuration values.

Database errors are reduced to a coarse class (`err.code || err.name`)
before logging. The fatal-error path in `boot.js` follows the same rule
— it logs the coarse class, never the raw error message, because
`pg`-originated errors can include the connection string.

The runtime audit log (`governance_audit_log`) is for memory-governance
events; runtime configuration events are operational logs only, never
written to the audit log.

### Structured-log contract

All runtime logging flows through one logger module
(`src/runtime/log.js`). Every entry is **one line of JSON** with the
core fields below, plus any caller-supplied fields:

| Field | Source | Notes |
|---|---|---|
| `ts` | `new Date().toISOString()` | core, reserved |
| `level` | `info` / `warn` / `error` | core, reserved |
| `event` | the stable, namespaced event name | core, reserved |
| `pid` | `process.pid` | core, reserved |
| `…fields` | caller-supplied | safe scalars only — see below |

**Reserved fields** (`ts`, `level`, `event`, `pid`) cannot be overridden
by caller-supplied fields; an attempt to override is silently dropped.

**Allowed caller-supplied field kinds**:

- a coarse `error_class` (the value of `err.code || err.name`);
- a runtime `state` name;
- an integer `port`;
- counts (`attempt`, `max`, `attempts`);
- a fixed reason string from a controlled set (e.g. the
  `resolvePilotFrom` reasons).

**Forbidden field kinds** (review-enforced, plus a positive no-leak
unit test):

- the database connection string or any URL containing credentials;
- a password or any secret;
- persona text, companion name, supported-person name, or any
  `companion_profile` / `supported_person_profile` content;
- a raw `err.message` (which can echo the connection string for pg
  errors).

The `src/db/client.js` log callback receives the same structured shape
— `(level, event, fields)` — so events emitted from the database
client are produced as full structured entries, not as strings to be
re-parsed.

The current event-name catalog lives alongside the call sites in
`src/runtime/boot.js` and `src/db/client.js`. New events follow the
same `<scope>.<thing>[.<detail>]` naming and must obey the field rules
above.

## 6. Health output

The `/healthz`, `/readyz`, and `/status` endpoints receive only the
current runtime state, feature-flag booleans, and the boot time. By
construction they cannot expose configuration content, persona,
profile, or secrets.

## 7. Enforcement

| Property | Enforced by |
|---|---|
| Forbidden SQL keywords | `check-runtime-boundary.js` (CI) |
| `FROM`/`JOIN` allowlist | `check-runtime-boundary.js` (CI) |
| Forbidden model-SDK imports | `check-runtime-boundary.js` (CI) |
| `pg` scoping to `src/db/client.js` | `check-runtime-boundary.js` (CI) |
| Reference-system contamination | `check-contamination.js` (CI) |
| Configuration-contract validity | `check-config-schema.js` (CI) |
| Fail-closed behavior across runtime states | `tests/runtime/` + `tests/integration/` |
| Health output never leaks persona/profile/secret | `tests/runtime/health.test.js` + `tests/integration/boot.test.js` |
| Logging hygiene | review (no mechanical check today) |

## 8. Change control

This file is locked. Adding a query, adding a table to the allowlist,
relaxing the import rules, or otherwise widening the runtime boundary
requires a reviewed change to this file **and** the corresponding
guard, in the same PR. Narrowing the boundary is welcome and never
requires a contract change beyond the doc update.

## Cross-references

- `companion-configuration-boundary.md` — the platform-vs-companion
  boundary the runtime serves.
- `companion-config-contract.md` — the configuration contract the
  runtime validates against.
- `source-of-truth-memory-policy.md` — the memory governance that the
  runtime is **not yet** allowed to touch.
- `baseline-ci.md` — the CI guards that enforce this boundary.
- `../../scripts/ci/check-runtime-boundary.js` — the guard.
