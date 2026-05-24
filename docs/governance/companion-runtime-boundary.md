# Companion-Runtime Boundary

**Applies to:** the companion-side module in `src/companion/` — the
first governed consumer of the memory-governance library, introduced
in GM-19.
**Status:** locked. Changes go through a reviewed change to this file
and `scripts/ci/check-companion-boundary.js` in the same PR.
**Depends on:** `memory-runtime-boundary.md` (the library this module
consumes), `source-of-truth-memory-policy.md` (the privacy policy the
chain enforces), `rls-privacy-contract.md` (the engaged RLS policies),
`runtime-boundary.md` (the separate config-loader boundary this
module does not relax).

## Purpose

GM-17/GM-18 introduced and hardened the memory-governance library
(`src/memory/`) as a library-only surface. GM-19 introduces the
**first read-only governed external consumer** of that library —
nothing more. The companion module proves the consumer pattern: how
code OUTSIDE `src/memory/` reaches the memory tables without
weakening any prior isolation guarantee, without raw DB access, and
without ever logging memory content.

This boundary is layered strictly on top of the memory library; it
adds no new RLS policy, no new INSERT path, no new endpoint, no
boot-mount, no new env var, and no new dependency.

## 1. Module placement

```
src/
  runtime/    — config loader (GM-7/16); connects as lylo_runtime.
                Guarded by check-runtime-boundary.js. Never imports
                src/memory/ or src/companion/.
  db/         — runtime pool; guarded by check-runtime-boundary.js.
  memory/     — memory-governance library (GM-17/18); connects as
                lylo_app. Guarded by check-memory-boundary.js. Never
                imports src/runtime/, src/db/, or src/companion/.
  companion/  — NEW (GM-19). First read-only consumer of the memory
                library. Library-only — not boot-mounted. Imports
                ONLY from require('../memory') (the public index —
                never the internal modules). No pg, no http, no
                model SDKs, no SQL keywords of any kind. Guarded by
                NEW check-companion-boundary.js.
```

GM-19 does NOT mount the companion module from the runtime boot
path. The module is a library consumed by integration tests in this
PR; future GMs that introduce companion behavior — and only then,
with explicit owner approval — will be the first production callers.

## 2. Public API surface (GM-19)

| Export | Purpose |
|---|---|
| `createCompanionReader({memoryPool, log?})` | Factory. Caller owns the `MemoryPoolHandle` (per OQ-19.3) and passes an optional logger duck-typed to `src/companion/log.js`. Returns a frozen reader exposing exactly one method: `readVisibleMemories`. |
| `reader.readVisibleMemories({pilotInstanceId, userId, userRole, limit?})` | Validates the four inputs against the same UUID/role constraints the memory library uses, then calls `withMemoryContext` + `ctx.listVisibleMemories`. Returns the rows unchanged. |
| `MemoryRepositoryError` | Re-exported from `src/memory` so consumers can `instanceof`-check without importing two packages (OQ-19.4). |

The returned reader is `Object.freeze`d. It exposes **only**
`readVisibleMemories` — never the pool, the handle, a `connect`
method, or a raw `query` method. Closing the pool is the **caller's**
responsibility via the memory module's `closeMemoryPool(handle)`
(per OQ-19.3 — caller owns lifecycle).

## 3. Identity convention

Per OQ-19.6 the reader accepts **caller-supplied** UUIDs and the role
token, and validates the shape (UUID via `UUID_RE`, role against the
five-element `VALID_ROLES` set) BEFORE any DB call.

The reader does NOT:
- authenticate, log in, or issue session tokens;
- resolve usernames or emails to user_ids;
- look up `users.role` from the DB;
- accept any value derived from a request header without server-side
  cross-checking (no GM-19 caller is HTTP; future GMs that introduce
  HTTP must satisfy this).

The CALLER (today: integration tests; tomorrow: a future GM's auth
layer) is responsible for resolving authenticated identity to
`{pilotInstanceId, userId, userRole}` before invoking the reader.

## 4. Logging hygiene

The reader logs at most one line per successful read:

```
{"ts":"…","level":"info","event":"companion.memory.read","pid":…,
 "pilot_instance_id":"<uuid>","actor_user_id":"<uuid>",
 "actor_role":"<role>","count":<n>}
```

Memory **content is never logged**. The unit test plants a sentinel
substring inside the rows returned by a mocked `listVisibleMemories`
and asserts the sentinel does not appear in any captured log line —
the central GM-19 privacy assertion.

The validation-error messages reference field names only ("userId
must be a UUID") — never the offending caller-supplied value. The
unit test plants a suspicious value and asserts the message does not
echo it.

The companion module's logger (`src/companion/log.js`) is a sibling
of `src/runtime/log.js` and `scripts/setup/log.js`. Same JSON-line
shape, same reserved core fields (`ts`, `level`, `event`, `pid`),
same forbidden-field rules. The sibling pattern keeps the companion
module from importing across the runtime/companion boundary.

## 5. Boundary guard

`scripts/ci/check-companion-boundary.js` scans `src/companion/` only
and fails the build on:

| Violation | Reason |
|---|---|
| Any forbidden SQL keyword in code (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `CREATE`, `SELECT`, `FROM`, `JOIN`, `WHERE`) | The companion module performs zero raw SQL. Every memory access goes through the memory library's `ctx`. |
| The identifier `insertPrivateMemory` appearing in code | The reader's `ctx` exposes both `listVisibleMemories` and `insertPrivateMemory`; the companion module must structurally avoid calling the latter. |
| Import of `pg` | The companion module never accesses the DB driver directly. |
| Import of a model SDK (`openai`, `anthropic`, `@anthropic-ai/sdk`, `@anthropic-ai/*`, `@openai/*`) | GM-19 has no inference. |
| Import of `http`, `https`, `express`, `fastify`, `koa`, `@hapi/hapi` | GM-19 has no HTTP endpoint. The companion module is library code. |
| Memory-module import reaching past the public entry (`../memory/repository`, `../memory/transaction`, `../memory/audit`, `../memory/client`, `../memory/errors`) | Only `../memory` and `../memory/index` are permitted. Internal modules are not callable from outside `src/memory/`. |

## 6. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| Read-only consumer can `INSERT` / `UPDATE` / `DELETE` memory tables | `check-companion-boundary.js` bans all write SQL keywords AND the `insertPrivateMemory` identifier. The reader never calls `ctx.insertPrivateMemory`. |
| Read-only consumer can promote visibility (private → family_shared) | No write surface to set visibility; `lylo_app` has no `UPDATE` grant on `memory_store` (GM-15). |
| Read-only consumer can open or revoke a vault session | The reader does not call any `memory_vault_sessions` op; the memory library does not expose one in GM-17/18; even if it did, the missing `WITH CHECK` INSERT policy on `memory_vault_sessions` would block it. |
| Read-only consumer can retract or supersede a memory | Same — no UPDATE grant, no exposed op. |
| Read-only consumer can invoke inference / call a model SDK | `check-companion-boundary.js` bans the SDK imports. |
| Read-only consumer can mount a user-facing endpoint | `check-companion-boundary.js` bans `http`/`https`/`express`/`fastify`/`koa`/`@hapi/hapi`. |
| Read-only consumer can reach the raw `pg.Pool` | `check-companion-boundary.js` bans `pg` import. The memory module exposes only a `MemoryPoolHandle`, which has no `.connect`/`.query`/`.end` (GM-18 opaque handle). |
| Read-only consumer can bypass audit-bundling | Every read goes through `ctx.listVisibleMemories`, which always inserts a `memory.list` audit row in the same transaction; integration test 7 asserts the audit log grows by exactly one row per call. |
| Read-only consumer can log memory content | Sentinel-content unit test scans captured log output and asserts the sentinel is absent. Reader logs only metadata fields. |
| Read-only consumer can cross-pilot read | Tenant-scope RLS narrows under `lylo_app`; integration test 5 asserts pilot-B senior never sees pilot-A memories via the reader. |
| Caller-contract validation errors echo caller-supplied values | Unit test plants a suspicious value and asserts the validation message does not include it. |

## 7. Operations explicitly NOT in this surface (deferred)

Same set as GM-17/GM-18's deferred list:
- visibility promotion / demotion;
- admissibility transitions, retraction, supersession;
- vault session opening / failed-attempt accounting / lockout;
- companion persona behavior, conversation runtime, inference;
- HTTP endpoints / authentication.

Each requires its own owner decision and either GRANT changes, new
RLS policies, or new boundary doc + guard.

## 8. Enforcement

| Property | Enforced by |
|---|---|
| SQL keyword ban in `src/companion/` | `check-companion-boundary.js` (CI) |
| `pg`, model-SDK, HTTP-framework import bans | `check-companion-boundary.js` (CI) |
| Memory-module import discipline (entry-only) | `check-companion-boundary.js` (CI) |
| `insertPrivateMemory` identifier ban | `check-companion-boundary.js` (CI) |
| Input validation BEFORE any DB call; frozen reader; logger hygiene | `tests/companion/reader.test.js` (unit) |
| Per-role visibility parity; cross-pilot isolation; no-write invariant; one audit row per read; `MemoryRepositoryError` shape from a real FK violation | `tests/integration/companion-read.test.js` |

## 9. Change control

Adding a new exported companion operation, expanding the reader's
return shape to include derived data, introducing a model SDK, or
mounting the module from boot is a boundary change. It requires a
reviewed change to this document **and**
`check-companion-boundary.js` in the same PR. Adding a new memory
operation that the reader consumes requires the corresponding update
to `memory-runtime-boundary.md` first.

## Cross-references

- `memory-runtime-boundary.md` — the library this module consumes.
- `source-of-truth-memory-policy.md` — the privacy policy the chain
  enforces.
- `rls-privacy-contract.md` — the engaged RLS policies + DB-role
  model.
- `runtime-boundary.md` — the separate (and tighter) config-loader
  boundary GM-19 does not relax.
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-companion-boundary.js` — the guard.
- `../../src/companion/` — the module.
- `../../tests/integration/companion-read.test.js` — the contract
  proof.
