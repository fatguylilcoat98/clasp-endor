# Database migrations

Migrations for the Lylo Companion platform live here, one file per
migration, numbered sequentially (`NNN_short_description.sql`).

## Status (GM-3)

The clean baseline schema is in place: migrations `001`–`006`. The master
starts a **clean** migration chain — no historical or archived SQL is
carried over from any reference system.

| Migration | Establishes |
|---|---|
| `001_baseline.sql` | `pilot_instances` (tenancy root), `users`, one-senior-per-pilot. |
| `002_profiles.sql` | `companion_profile`, `supported_person_profile`, `circle_contacts`. |
| `003_vaults.sql` | `memory_vaults`, `memory_vault_sessions`. |
| `004_memory_store.sql` | `memory_store` with provenance / visibility / admissibility columns + an immutability trigger. |
| `005_audit_log.sql` | `governance_audit_log` + an append-only trigger. |
| `006_setup_state.sql` | `setup_state`. |

### Deferred — not in GM-3

- **Row-level security.** No table has RLS enabled and no policy exists
  yet. RLS `ENABLE` / `FORCE` and all policies land later as one atomic
  migration with the RLS contract port.
- **Admissibility lifecycle.** GM-3 ships the `admissibility_state`
  column and the `superseded_by` link only; the proposed/pending/verified
  flow, dispute handling, the authority-validation workflow, and the
  review queue are a later migration.
- Derived-memory, outbound-message, and compose-authorization tables.

## Rules

- One file per migration, numbered `NNN_*.sql`.
- Additive-first; destructive changes require explicit owner sign-off
  recorded in the migration header.
- Each migration opens with a `-- Plan:` comment and ends with its
  rollback SQL, commented, after the body.
- The master ships schema only — never client data. A copied instance
  runs these migrations against its own empty database.
