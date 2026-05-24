# RLS / Privacy Contract

**Applies to:** the row-level-security policies on the real
`db/migrations/` schema. As of GM-15 they live in
`db/migrations/007_rls_policies.sql`; they are mechanically validated
in CI against both the synthetic schema (`run-contract.js`) and the
real migrations (`run-real.test.js`). RLS is **dormant in production**
until GM-16 wires the runtime / provisioning to connect via the
`lylo_*` roles — see "Runtime wire-up status" below.
**Status:** locked. Changes go through a reviewed change to this file,
`tests/rls-contract/policies.sql`, and `db/migrations/007_rls_policies.sql`
together.
**Depends on:** `source-of-truth-memory-policy.md` (the policy this
contract enforces), `runtime-boundary.md` (the runtime stays
read-only), `companion-config-contract.md` (the four config tables the
runtime reads).

## Purpose

The runtime configuration loader is read-only and touches only four
tables. The next phase — memory-governance extraction — will write and
read the memory tables, and the privacy guarantees in
`source-of-truth-memory-policy.md` must be enforced **at the database
level**, not only by application code. This document defines those
guarantees as a mechanical contract: a set of candidate RLS policies,
a session-variable convention, a DB-role model, and a CI-enforced
test matrix that exercises the access rules across roles, pilots,
visibility levels, and vault-session states.

As of GM-15, the contract is applied to the real schema by
`db/migrations/007_rls_policies.sql` and re-verified against the real
migrations on every PR by `tests/rls-contract/run-real.test.js`. The
synthetic suite (`run-contract.js`) remains: it is the contract's
machine-readable specification, useful for reviewing policy changes in
isolation from the application schema. Both suites run in the single
`rls-contract` CI job.

## Session-variable convention

The connecting application sets three session variables per request
(via `SET LOCAL app.* = '...'` inside a transaction):

| Variable | Meaning |
|---|---|
| `app.pilot_instance_id` | The user's pilot scope (UUID) |
| `app.user_id` | The connecting user (UUID) |
| `app.user_role` | Their role token: `senior` / `family` / `caregiver` / `admin` / `system` |

Policies read these with `current_setting('app.user_id', true)::uuid`.
When unset, `current_setting('…', true)` returns `NULL`; the equality
check yields `NULL` and the row is filtered out — default-deny.

## DB-role model

GM-15's `db/migrations/007_rls_policies.sql` creates the following
Postgres roles in the cluster. They are all `NOLOGIN`; GM-16 will
introduce the LOGIN role(s) the connecting application uses to acquire
them (decision OQ-15.5: separate LOGIN role + separate `DATABASE_URL`
per process — `LYLO_RUNTIME_DATABASE_URL`, `LYLO_SETUP_DATABASE_URL`).

| Role | Purpose | Table grants |
|---|---|---|
| `lylo_runtime` | Runtime configuration loader (GM-7b) | SELECT on `pilot_instances`, `companion_profile`, `supported_person_profile`, `setup_state` |
| `lylo_app` | Memory-governance runtime (future GM) | SELECT on all client-scoped tables; INSERT on `memory_store`, `governance_audit_log`, `memory_vault_sessions`; UPDATE (`revoked_at`) on `memory_vault_sessions`; all gated by RLS policies |
| `lylo_setup` | Offline provisioning script (GM-12) | INSERT/SELECT on the four config tables + `users`; `BYPASSRLS` so it can seed |
| `lylo_admin` | Operator | SELECT on most tables; **no** policy on `memory_store` or `memory_vaults`, so admins cannot see private memories or vault PIN hashes |

Defense in depth: the table-level `GRANT` limits *which tables* a role
can address at all; RLS policies limit *which rows* within those
tables.

### Bootstrap policy for `lylo_runtime` on `pilot_instances`

Per OQ-15.2, the GM-15 migration installs a role-scoped policy
`pilot_instances_runtime_bootstrap ON pilot_instances FOR SELECT TO
lylo_runtime USING (true)`. This is intentional: GM-16's env-first
boot model sets `app.pilot_instance_id` before any query, so the
tenant-scope policy already permits the read; the bootstrap policy
fails closed only if env is misconfigured (the runtime sees all pilots
instead of zero). Safe under single-tenant — each runtime owns one
`DATABASE_URL` pointing at one pilot. `lylo_app` and `lylo_admin` are
NOT covered by the bootstrap policy and remain bound by the
tenant-scope rule on `pilot_instances`.

## Per-table policies

The runnable forms live in two places, byte-for-byte semantically
equivalent:

- `../../db/migrations/007_rls_policies.sql` — applied to the real
  schema.
- `../../tests/rls-contract/policies.sql` — applied to the synthetic
  schema by the contract suite.

The semantic summary:

### Tenant-scoped SELECT (every client-scoped table)

A row is visible only if `pilot_instance_id = current_setting('app.pilot_instance_id')::uuid`.
This is the single rule that produces **cross-pilot isolation**.

### `circle_contacts`

Visible to: the senior themselves; the contact themselves; admins in
the same pilot.

### `memory_vaults` and `memory_vault_sessions`

Visible to: the owning user **only**. Admin sees nothing. The PIN
hash and session state are private to the supported person.

### `memory_store`

Three permissive SELECT policies (OR'd):

1. **Owner** — the supported person sees all their own rows regardless
   of `visibility_level` or `admissibility_state`.
2. **`family_shared` circle** — visible iff:
   - `visibility_level = 'family_shared'`,
   - `admissibility_state = 'admissible'`,
   - a `circle_contacts` row links the owner to the connecting user
     **with `permission_scope.visibility_levels` containing
     `'family_shared'`**.
3. **`password_locked` session** — visible iff:
   - `visibility_level = 'password_locked'`,
   - `admissibility_state = 'admissible'`,
   - `vault_id IS NOT NULL`,
   - a `memory_vault_sessions` row exists for the connecting user with
     `expires_at > now()` and `revoked_at IS NULL` (the row-state
     vault model from OQ-14.3).

There is **no admin SELECT policy** on `memory_store` (OQ-14.2):
admins cannot see `private` or `password_locked` rows.

`INSERT` policy: the connecting user can only insert memories with
`owning_user_id = app.user_id` (no impersonation).

### `governance_audit_log`

- Admins see all in-pilot events (SELECT).
- A user sees events where they are the `target_user_id` (SELECT).
- `INSERT` requires `actor_user_id = app.user_id` (no impersonation).
- The real schema's append-only trigger remains the authority on
  UPDATE/DELETE rejection.

## Cross-pilot isolation rule

Every policy in this contract is `pilot_instance_id`-scoped. There is
**no** policy that exposes a row whose `pilot_instance_id` does not
match `current_setting('app.pilot_instance_id')::uuid`. Cross-pilot
reads are mechanically impossible under any role / context.

## Default-deny rule

When RLS is `ENABLE`d on a table and no policy permits the row, the
row is invisible. The contract enables RLS on every client-scoped
table; therefore **any table the connecting application can address
but has no matching policy returns zero rows**.

If a future PR adds a new table to `db/migrations/` without adding a
policy in this contract, the runtime cannot read it. That is
intentional: new tables must be paired with new contract entries.

## Vault-session row-state model (OQ-14.3)

The `password_locked` visibility policy is **row-state-based**: a
`memory_vault_sessions` row whose `expires_at` has passed, or whose
`revoked_at` is non-null, does **not** unlock memories. There is no
session-variable shortcut; the application cannot fake a vault session
by setting a flag. The vault is unlocked iff the row exists in the
correct state.

## What the contract enforces and what it does not

The contract enforces:

- Tenant isolation (cross-pilot reads impossible).
- The `memory_store` visibility matrix above.
- Vault content / session privacy.
- Admin denial on private memory.
- Default-deny when policies are missing or session variables unset.
- INSERT-impersonation prevention via `WITH CHECK`.

The contract does **not** model:

- Memory immutability (real schema's BEFORE-UPDATE trigger).
- Audit append-only (real schema's BEFORE-UPDATE-OR-DELETE trigger).
- Application-level admissibility lifecycle, retraction, supersession
  workflow — these are policy concerns from
  `source-of-truth-memory-policy.md` enforced at the application
  layer.
- Authentication or the service-login role that the application uses
  to acquire `lylo_app`.

## CI enforcement

The `rls-contract` baseline-CI job runs the matrix on every PR against
both the synthetic schema (`run-contract.js`) and the real
migrations (`run-real.test.js`). It is no longer a scaffold; a failure
in either suite fails the build. See `baseline-ci.md`.

## Runtime wire-up status

| Step | Status | PR |
|---|---|---|
| Synthetic contract validates policies | Landed | GM-14 |
| Real-schema migration installs roles, GRANTs, RLS, policies | Landed | GM-15 |
| Real-schema contract suite runs on every PR | Landed | GM-15 |
| Runtime connects as `lylo_runtime` via `LYLO_RUNTIME_DATABASE_URL` | Deferred | GM-16 |
| Loader sets `app.pilot_instance_id` (env-first, OQ-15.2) | Deferred | GM-16 |
| Provisioning connects as `lylo_setup` via `LYLO_SETUP_DATABASE_URL` | Deferred | GM-16 |

As of GM-15, `db/migrations/007_rls_policies.sql` creates the four
`lylo_*` roles, applies the policies, and enables RLS on the ten
client-scoped tables. **But the runtime and provisioning scripts still
connect with the operator's `DATABASE_URL`**, typically a bootstrap
superuser that has `BYPASSRLS` by default. RLS therefore exists on the
schema but is dormant for the connecting application until GM-16
flips the connection role.

GM-16 (separate PR, separate decision gate) will:

1. Introduce `LYLO_RUNTIME_DATABASE_URL` and `LYLO_SETUP_DATABASE_URL`
   in `parseEnv`. Operator provisions LOGIN roles whose effective
   identity is `lylo_runtime` / `lylo_setup`.
2. Update `src/runtime/boot.js` and `src/db/client.js` so the runtime
   reads `LYLO_RUNTIME_DATABASE_URL` and `SET LOCAL
   app.pilot_instance_id` from `LYLO_PILOT_INSTANCE_ID` (env-first)
   on every loader transaction. The `lylo_runtime` bootstrap policy
   on `pilot_instances` provides belt-and-suspenders coverage if env
   is misconfigured.
3. Update `scripts/setup/provision-instance.js` to read
   `LYLO_SETUP_DATABASE_URL`. `lylo_setup` has `BYPASSRLS` for seeding.
4. Add an integration test that boots under `lylo_runtime` and
   asserts the loader's read-only contract still holds.

Until GM-16 lands, the runtime relies on single-tenant physical
isolation, the runtime-boundary guard, and the GM-15 migration sitting
ready in production but not yet engaged by the application.

## Change control

Locked. Any change to a policy or to the DB-role model is a reviewed
change to **this document**, **`tests/rls-contract/policies.sql`**,
and **`db/migrations/007_rls_policies.sql`** together in the same PR.
Adding a new table to `db/migrations/` requires adding a corresponding
policy here, in the synthetic `policies.sql`, and in `007` (or a
follow-on numbered migration) in the same PR.

## Cross-references

- `source-of-truth-memory-policy.md` — the privacy policy the contract
  enforces (§11 default-private, §12 family_shared rules, §13
  password_locked rules, §14 audit requirements).
- `runtime-boundary.md` — the runtime stays read-only against four
  tables.
- `companion-config-contract.md` — the four config tables.
- `baseline-ci.md` — the `rls-contract` job.
- `../../tests/rls-contract/policies.sql` — the synthetic-schema form.
- `../../tests/rls-contract/run-real.test.js` — the real-schema proof.
- `../../db/migrations/007_rls_policies.sql` — the real-schema
  application.
