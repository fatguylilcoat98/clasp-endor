# RLS / Privacy Contract

**Applies to:** the candidate row-level-security policies that GM-15
will apply to the real `db/migrations/` schema. Today they are
mechanically validated against a synthetic schema; the real schema is
unchanged.
**Status:** locked. Changes go through a reviewed change to this file
and `tests/rls-contract/policies.sql` together.
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

The contract is **synthetic** in this PR — applied to a separate
schema, not to the real migrations. GM-15 will apply the same policies
to the real schema atomically.

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

GM-15 creates the following Postgres roles in the cluster. They are
all `NOLOGIN` — the connecting application uses one of them via
`SET ROLE` after authenticating with a service login role.

| Role | Purpose | Table grants |
|---|---|---|
| `lylo_runtime` | Runtime configuration loader (GM-7b) | SELECT on `pilot_instances`, `companion_profile`, `supported_person_profile`, `setup_state` |
| `lylo_app` | Memory-governance runtime (future GM) | SELECT/INSERT on memory tables, gated by RLS policies |
| `lylo_setup` | Offline provisioning script (GM-12) | INSERT/SELECT on the four config tables; `BYPASSRLS` so it can seed |
| `lylo_admin` | Operator | SELECT on most tables; **no** policy on `memory_store` or `memory_vaults`, so admins cannot see private memories or vault PIN hashes |

Defense in depth: the table-level `GRANT` limits *which tables* a role
can address at all; RLS policies limit *which rows* within those
tables.

## Per-table policies

The full, runnable form lives in `../../tests/rls-contract/policies.sql`.
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

The `rls-contract` baseline-CI job runs the matrix on every PR. It is
no longer a scaffold; a failure fails the build. See
`baseline-ci.md`.

## Promotion to the real schema (GM-15)

GM-15 will:

1. Add a single new migration (`db/migrations/007_rls_policies.sql`)
   that `CREATE ROLE`s `lylo_runtime` / `lylo_app` / `lylo_setup` /
   `lylo_admin`, issues the matching `GRANT`s, `ENABLE`s RLS on the ten
   client-scoped tables, and applies the policies from this contract.
2. Update `src/runtime/boot.js` and `src/db/client.js` so the runtime
   connects as `lylo_runtime` and `SET LOCAL app.pilot_instance_id` on
   the loader's transaction.
3. Update `scripts/setup/provision-instance.js` so the provisioning
   script connects as `lylo_setup` (BYPASSRLS for seeding).
4. Re-run the contract suite **against the real schema** as a final
   gate (same `run-contract.js`, but pointed at the real migrations
   path).

Until GM-15 lands, the real schema remains RLS-free; the runtime relies
on single-tenant physical isolation and the runtime-boundary guard.

## Change control

Locked. Any change to a policy or to the DB-role model is a reviewed
change to **this document** and **`policies.sql`** together in the
same PR. Adding a new table to `db/migrations/` requires adding a
corresponding policy here in the same PR.

## Cross-references

- `source-of-truth-memory-policy.md` — the privacy policy the contract
  enforces (§11 default-private, §12 family_shared rules, §13
  password_locked rules, §14 audit requirements).
- `runtime-boundary.md` — the runtime stays read-only against four
  tables.
- `companion-config-contract.md` — the four config tables.
- `baseline-ci.md` — the `rls-contract` job.
- `../../tests/rls-contract/policies.sql` — the runnable contract.
