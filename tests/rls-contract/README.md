# RLS / privacy contract suite

The synthetic RLS / privacy contract: a generic Postgres schema,
candidate row-level-security policies, fixtures across two pilots, and
a test matrix that asserts the access / visibility rules. Run by the
`rls-contract` baseline-CI job against a throwaway Postgres 16 service
container.

The full contract is documented in
`../../docs/governance/rls-privacy-contract.md`.

## Files

| File | Purpose |
|---|---|
| `synthetic-schema.sql` | A minimal, structurally equivalent copy of the real `db/migrations/` shape, without the application-level invariant triggers. Fictional only. |
| `policies.sql` | The candidate RLS policies and DB-role model that GM-15 will apply to the real schema. |
| `fixtures.sql` | Two-pilot seed data: seniors, family, caregiver, admin, vaults with open and revoked sessions, memories at each visibility level, audit entries. |
| `run-contract.js` | `node:test` matrix runner — drops and recreates the public schema, applies the three SQL files in order, then asserts the visibility / write matrix from each role's perspective. |

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

- The real `db/migrations/` schema does **not** have RLS enabled — that
  is GM-15's atomic migration.
- The runtime modules (`src/runtime/`, `src/db/`) do not yet `SET LOCAL
  app.user_id` etc. — GM-15 wires the loader to set session variables
  per request.
- Application-level invariants (memory immutability, audit append-only
  triggers) are not modelled here; they are in the real migrations and
  validated by integration tests.

## Running locally

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
node --test tests/rls-contract/run-contract.js
```

The runner drops and recreates the public schema. **Never point it at
a real instance database.**
