# RLS / privacy contract suite

The RLS / privacy contract is exercised by two suites that share the
same matrix, fixtures, and identifiers:

- **Synthetic** (`run-contract.js`) — applies a generic schema, the
  candidate policies, and two-pilot fixtures to a throwaway Postgres,
  then asserts the access / visibility / write rules.
- **Real schema** (`run-real.test.js`, GM-15) — applies the real
  `db/migrations/0*.sql` chain (including
  `db/migrations/007_rls_policies.sql`), then runs the same matrix
  against the real schema. Catches drift between the policy contract
  and the production migrations.

Both suites are run by the single `rls-contract` baseline-CI job,
serially, against a throwaway Postgres 16 service container.

The full contract is documented in
`../../docs/governance/rls-privacy-contract.md`.

## Files

| File | Purpose |
|---|---|
| `synthetic-schema.sql` | A minimal, structurally equivalent copy of the real `db/migrations/` shape, without the application-level invariant triggers. Fictional only. |
| `policies.sql` | The candidate RLS policies and DB-role model — the contract's machine-readable specification, applied to the synthetic schema. Kept byte-for-byte semantically equivalent to `../../db/migrations/007_rls_policies.sql`. |
| `fixtures.sql` | Two-pilot seed data: seniors, family, caregiver, admin, vaults with open and revoked sessions, memories at each visibility level, audit entries. Shared by both suites; the real schema's additional columns take their defaults. |
| `run-contract.js` | `node:test` matrix runner for the synthetic schema. Drops and recreates the public schema, applies the three SQL files in order, then asserts the matrix from each role's perspective. |
| `run-real.test.js` | `node:test` matrix runner for the real schema. Drops and recreates the public schema, applies `db/migrations/0*.sql` in order (including `007_rls_policies.sql`), seeds `fixtures.sql`, then asserts the same matrix against the real tables. |

## What the contract proves

The suite verifies the access rules every PR:

- **Cross-pilot isolation** — a user in pilot A sees no rows from pilot B
  in any table, including the audit log.
- **memory_store visibility** — `private` only to the owner;
  admissible `family_shared` only to circle members whose
  `permission_scope.visibility_levels` includes `family_shared`;
  `password_locked` only with an unexpired, non-revoked
  `memory_vault_sessions` row.
- **Admin denial on private memory** — `admin` role sees no `private`
  or `password_locked` rows (OQ-14.2).
- **Vault privacy** — only the supported person sees their own
  `memory_vaults` row; admin never sees the PIN hash.
- **Write isolation** — `INSERT` into `memory_store` for another
  `owning_user_id` is blocked by the `WITH CHECK` policy; same for
  impersonating an `actor_user_id` in `governance_audit_log`.
- **Role-based grant boundary** — `lylo_runtime` cannot access
  `memory_store` at all (no table grant); the four config tables are
  tenant-scoped readable.
- **Default-deny** — with RLS enabled and no session-variable context,
  granted tables return zero rows.

## What the contract does **not** prove

- The runtime modules (`src/runtime/`, `src/db/`) do not yet connect
  as `lylo_runtime` or `SET LOCAL app.*` per request — that is GM-16's
  wire-up. After GM-15 the policies exist on the real schema but are
  dormant for the connecting application (which still uses the
  bootstrap `DATABASE_URL`, typically a superuser that bypasses RLS).
- Application-level invariants (memory immutability, audit append-only
  triggers) are not modelled here; they are in the real migrations and
  validated by integration tests.

## Running locally

Run both suites serially (matches CI):

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
node --test --test-concurrency=1 \
  tests/rls-contract/run-contract.js \
  tests/rls-contract/run-real.test.js
```

Each runner drops and recreates the public schema in its `before`
hook. **Never point them at a real instance database.**
