# Memory-Governance Runtime Boundary

**Applies to:** the memory-governance module in `src/memory/` — the
golden master's second executable runtime, layered on top of the GM-7
config loader and the GM-15/GM-16 RLS engagement.
**Status:** locked. Changes go through a reviewed change to this file
and the corresponding CI guard, in the same PR.
**Depends on:** `source-of-truth-memory-policy.md` (the policy this
module enforces), `rls-privacy-contract.md` (the engaged RLS
policies), `runtime-boundary.md` (the separate config-loader boundary
this module does not relax).

## Purpose

The GM-15 migration installed the real-schema RLS policies and the
four `lylo_*` DB roles. GM-16 wired the runtime config loader to
connect as `lylo_runtime`, engaging the policies for the config-read
path. GM-17 extracts the first **memory-governance** runtime — the
audit-bundled application surface that reads and writes the
`memory_store` and `governance_audit_log` tables under the
`lylo_app` DB role, with `app.pilot_instance_id`, `app.user_id`, and
`app.user_role` bound per request inside every transaction.

This document is the locked contract that boundary obeys. Drift is
mechanically prevented by `scripts/ci/check-memory-boundary.js`.

## 1. Module placement

The memory module lives in `src/memory/` and is the **only** code
permitted to connect as `lylo_app`. The runtime config loader
(`src/runtime/`, `src/db/`) stays exactly as it is — the existing
runtime boundary (`runtime-boundary.md`) is unchanged and still
forbids any FROM/JOIN outside the four config tables.

```
src/
  runtime/   — config loader; connects as lylo_runtime via
               LYLO_RUNTIME_DATABASE_URL. Guarded by
               check-runtime-boundary.js. Never imports src/memory/.
  db/        — low-level pg pool helper for the runtime. Guarded by
               check-runtime-boundary.js. Never imports src/memory/.
  memory/    — memory-governance library; connects as lylo_app via
               LYLO_APP_DATABASE_URL. Guarded by
               check-memory-boundary.js. Never imports src/runtime/
               or src/db/.
```

GM-17 does NOT mount the memory module from the runtime boot path.
The module is a library consumed by integration tests in this PR;
future GMs that introduce companion behavior will be the first
production callers.

## 2. Connection model

| Variable | Role | Notes |
|---|---|---|
| `LYLO_APP_DATABASE_URL` | LOGIN role with effective identity `lylo_app` | Read directly by `src/memory/client.js` (OQ-17.2 — `parseEnv` is unchanged in GM-17). Distinct LOGIN role from runtime and provisioning. |

Operator one-time setup (after migrations 001-007 and the LOGIN
roles for runtime/provisioning are in place):

```sql
CREATE ROLE lylo_app_login LOGIN PASSWORD '...' IN ROLE lylo_app;
-- Deliberately NO BYPASSRLS.
```

The **NO BYPASSRLS** rule is critical. Unlike `lylo_setup_login`,
which needs `BYPASSRLS` to seed bootstrap rows, `lylo_app_login`
must remain subject to RLS in every production path. An operator
who accidentally grants `BYPASSRLS` to this role silently disables
every privacy guarantee in this document. The
`memory-governance.test.js` integration test asserts
`pg_roles.rolbypassrls = false` for the test LOGIN role as a
regression guard.

## 3. Session-variable convention

Three session variables are bound by `withMemoryContext` inside
every transaction, via `SELECT set_config(name, value, true)`:

| Variable | Source | Used by which policies |
|---|---|---|
| `app.pilot_instance_id` | The pilot the caller is acting in; ultimately from `LYLO_PILOT_INSTANCE_ID` or an equivalent server-side resolution | Every tenant-scope policy on every client-scoped table |
| `app.user_id` | The connecting end-user's `users.id`; resolved server-side from authenticated identity, **never** read from a request header | `circle_contacts` / `memory_vaults` / `memory_vault_sessions` / `memory_store` (owner + family_shared) / `governance_audit_log` (target + INSERT actor check) |
| `app.user_role` | The corresponding `users.role`; looked up server-side from the authenticated identity, **never** trusted from a request header | `circle_contacts_admin`, `governance_audit_log_admin` |

`set_config(..., is_local=true)` is the parameter-safe equivalent of
`SET LOCAL` — the binding reverts at COMMIT/ROLLBACK and never
escapes the transaction, so a pooled connection cannot leak a prior
caller's identity to the next caller. `is_local` is **always** true;
`SET` and `SET SESSION` are not used.

**Per OQ-17.10, `app.session_id` is intentionally NOT used.** The
vault-unlock model is row-state-based (OQ-14.3): visibility of
`password_locked` memories depends on the existence of an unexpired
non-revoked `memory_vault_sessions` row whose `user_id` matches
`app.user_id`, not on a session-id channel. A future contributor who
proposes `app.session_id` must first revisit OQ-14.3.

## 4. Transaction discipline

```js
await client.query('BEGIN');
await client.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', pilotInstanceId]);
await client.query('SELECT set_config($1, $2, true)', ['app.user_id',          userId]);
await client.query('SELECT set_config($1, $2, true)', ['app.user_role',        userRole]);

// — sensitive op (SELECT or INSERT) —
// — paired audit INSERT in the SAME transaction —

await client.query('COMMIT');   // — or ROLLBACK on any throw —
```

Rules:

- Every memory-governance op runs inside an explicit
  `BEGIN`/`COMMIT` (or ROLLBACK on throw).
- `is_local` is **always** `true`.
- Every memory write is paired with an audit INSERT in the same
  transaction. If either throws, both roll back.
- `withMemoryContext` is the only place these rules live; callers
  cannot bypass it because the raw pg client is never exposed
  outside `src/memory/`.

## 5. Public API surface (GM-17)

Exactly two audit-bundled operations, both invoked through the `ctx`
the caller receives from `withMemoryContext`:

| Operation | Reads | Writes | Audit event |
|---|---|---|---|
| `ctx.listVisibleMemories({ limit? })` | `memory_store` (RLS-narrowed) | none | `memory.list` with `outcome='allowed'`, `reason='count=N'` |
| `ctx.insertPrivateMemory({ content, provenance })` | none | One `memory_store` row with `visibility_level='private'`, `admissibility_state='admissible'`, `owning_user_id=app.user_id`; one `governance_audit_log` row | `memory.created` with `memory_id`, `target_user_id=actor`, `outcome='allowed'` |

`insertPrivateMemory` hard-codes visibility to `'private'` per §11 of
`source-of-truth-memory-policy.md`. Promoting a memory to
`family_shared` or `password_locked` is **not** in this surface (see
§7 below).

The repository functions (`listVisibleMemories`,
`insertPrivateMemory`) and the internal audit helper
(`insertAuditEvent`) are NOT re-exported from `src/memory/index.js`.
The only entry points callers should `require` are
`createMemoryPool`, `closeMemoryPool`, and `withMemoryContext`.

## 6. Boundary guard

`scripts/ci/check-memory-boundary.js` scans `src/memory/` only and
fails the build on:

| Violation | Reason |
|---|---|
| Forbidden SQL keyword in code: `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `CREATE` | GM-17 needs none of these. `UPDATE` and `DELETE` are explicitly banned because no GM-17 op mutates an existing row. |
| `FROM`/`JOIN` referencing a table outside the read allowlist (`memory_store`, `memory_vaults`, `memory_vault_sessions`, `governance_audit_log`, `circle_contacts`, `users`, `pilot_instances`) | The memory module's read surface is wider than the runtime's but still finite. New tables require a paired RLS policy and a guard update. |
| `INSERT INTO` referencing a table outside the write allowlist (`memory_store`, `governance_audit_log`) | The two tables this PR's API writes. New INSERT targets require explicit owner approval. |
| Import of a model SDK (`openai`, `anthropic`, `@anthropic-ai/sdk`, `@anthropic-ai/*`, `@openai/*`) | GM-17 has no inference. |
| Import of `pg` outside `src/memory/client.js` | The only place that constructs the pool; transaction.js, repository.js, and audit.js operate on a client passed to them. |

The existing `check-runtime-boundary.js` is unchanged and continues
to enforce the much tighter rules for `src/runtime/` and `src/db/`
(four-table allowlist, every write keyword banned including
`INSERT`).

## 7. Operations explicitly NOT in this surface (deferred)

| Operation | Why deferred | What it would need |
|---|---|---|
| Vault session opening (PIN verify, INSERT `memory_vault_sessions`) | No `WITH CHECK` INSERT policy on `memory_vault_sessions` in GM-15. PIN verification is app-side; failed-attempt accounting needs `UPDATE memory_vaults.failed_attempt_count` / `lockout_until` (no grant). | A new INSERT policy + `UPDATE` grants on `memory_vaults`. Owner-decided in a future GM. |
| Visibility promotion (`private` → `family_shared`, etc.) | §11 of `source-of-truth-memory-policy.md` requires authority validation; GM-17 has no UPDATE grant on `memory_store`. | `UPDATE` grant on specific columns; new audit event types. |
| Admissibility transitions, retraction, supersession | Same — needs `UPDATE` on `memory_store.admissibility_state` / `superseded_by` / `active`. The immutability trigger permits these columns; the GRANT layer doesn't. | `UPDATE` grant + new audit event types + supersession event linking. |
| Cross-user reads via admin or family pathways beyond what RLS already permits | Out of scope; the existing policies are authoritative. | — |
| Companion behavior, inference, conversation runtime | Hard limit on this PR. | A future GM with explicit owner approval. |

The `check-memory-boundary.js` forbidden-keyword set encodes these
deferrals: an attempt to add `UPDATE memory_store …` to the module
fails the build.

## 8. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| The runtime config loader never touches memory tables | `check-runtime-boundary.js` (unchanged) — its FROM/JOIN allowlist is still the four config tables. |
| `lylo_runtime` cannot read memory tables | Postgres `GRANT` layer; proven by `tests/integration/rls-engagement.test.js` from GM-16. |
| `lylo_app` cannot cross-pilot read | Tenant-scope RLS policies; proven by `tests/integration/memory-governance.test.js` scenario 5. |
| Family without `family_shared` permission cannot read family-tier memories | `memory_store_family_shared` policy requires the circle row to carry `family_shared` permission; proven by scenarios 2-3. |
| Admin cannot read private memory (OQ-14.2) | No admin SELECT policy on `memory_store`; proven by scenario 4. |
| `password_locked` memories invisible without an open session row | `memory_store_password_locked` policy requires a matching `memory_vault_sessions` row; vault opening is deferred so in production this means password_locked memories are normally invisible. |
| Memory mutation of immutable columns | `trg_memory_store_immutable_columns` BEFORE-UPDATE trigger raises; defense in depth from the absent `UPDATE` grant. |
| Unaudited sensitive access | Audit-bundled API + `check-memory-boundary.js` (`pg` scoped to `client.js`; no raw `client.query` exported); proven by scenarios 7, 9. |
| Cross-user INSERT impersonation | `memory_store_insert_own` `WITH CHECK` policy on the GRANT layer; proven by scenario 10. |
| `lylo_app` writing config tables | No grants; proven by scenario 11. |
| `lylo_app_login` carries `BYPASSRLS` (silent RLS bypass) | Operator-policy in §2; regression-checked by scenario 12. |

## 9. Logging hygiene

The memory module emits structured log events through the runtime
logger contract (`src/runtime/log.js` shape) — same JSON-line
format, same reserved core fields, same forbidden-field rules.
Specifically, the memory module never logs:

- the connection string or any URL with credentials;
- the plaintext content of a memory;
- the persona/profile/companion-name of the supported person;
- the raw error message from a pg-originated error (which can echo
  the connection string).

Database errors are reduced to a coarse class via
`describeDbError(err) = err.code || err.name || 'error'`.

## 10. Enforcement

| Property | Enforced by |
|---|---|
| Forbidden SQL keywords | `check-memory-boundary.js` (CI) |
| `FROM`/`JOIN` and `INSERT INTO` allowlists | `check-memory-boundary.js` (CI) |
| Forbidden model-SDK imports | `check-memory-boundary.js` (CI) |
| `pg` scoping to `src/memory/client.js` | `check-memory-boundary.js` (CI) |
| Transaction discipline (BEGIN + 3× set_config + fn + COMMIT/ROLLBACK; ctx never exposes raw client) | `tests/memory/transaction.test.js` (unit) |
| Per-role visibility matrix; cross-pilot isolation; default-deny; cross-user impersonation; audit bundling; LOGIN role NO-BYPASSRLS | `tests/integration/memory-governance.test.js` |
| RLS policies themselves | `tests/rls-contract/run-contract.js` + `tests/rls-contract/run-real.test.js` (existing) |

## 11. Change control

Adding a new exported memory operation, a new session variable, a
new INSERT target, or a new FROM/JOIN table is a boundary change.
It requires a reviewed change to this document **and**
`check-memory-boundary.js` in the same PR. Adding a new RLS policy
or a new column to a memory table requires the same plus an update
to `rls-privacy-contract.md` and `db/migrations/007_rls_policies.sql`
(or a follow-on numbered migration).

## Cross-references

- `source-of-truth-memory-policy.md` — the privacy policy this
  module enforces.
- `rls-privacy-contract.md` — the engaged RLS policies + DB-role
  model.
- `runtime-boundary.md` — the separate (and tighter) config-loader
  boundary that GM-17 does not relax.
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-memory-boundary.js` — the guard.
- `../../src/memory/` — the module.
- `../../tests/integration/memory-governance.test.js` — the
  contract proof.
