# Database migrations

Migrations for the Lylo Companion platform live here, one file per
migration, numbered sequentially (`NNN_short_description.sql`).

## Status (GM-15)

Migrations `001`–`007` are in place: the GM-3 baseline schema plus the
GM-15 RLS / privacy policies. The master starts a **clean** migration
chain — no historical or archived SQL is carried over from any
reference system.

| Migration | Establishes |
|---|---|
| `001_baseline.sql` | `pilot_instances` (tenancy root), `users`, one-senior-per-pilot. |
| `002_profiles.sql` | `companion_profile`, `supported_person_profile`, `circle_contacts`. |
| `003_vaults.sql` | `memory_vaults`, `memory_vault_sessions`. |
| `004_memory_store.sql` | `memory_store` with provenance / visibility / admissibility columns + an immutability trigger. |
| `005_audit_log.sql` | `governance_audit_log` + an append-only trigger. |
| `006_setup_state.sql` | `setup_state`. |
| `007_rls_policies.sql` | The four `lylo_*` DB roles, schema USAGE + per-table GRANTs, `ENABLE ROW LEVEL SECURITY` on the ten client-scoped tables, and the validated RLS policies. See `docs/governance/rls-privacy-contract.md`. RLS is dormant in production until GM-16 wires the connection roles. |

### Deferred — not in GM-15

- **Runtime / provisioning connection wire-up.** GM-15 installs the
  `lylo_*` roles and the policies; GM-16 will switch the runtime
  (`src/runtime/`, `src/db/`) and the provisioning script
  (`scripts/setup/`) onto those roles via
  `LYLO_RUNTIME_DATABASE_URL` and `LYLO_SETUP_DATABASE_URL`. See
  `docs/governance/rls-privacy-contract.md` §"Runtime wire-up status".
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
