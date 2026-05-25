# TEST INSTANCE — SAFE TO BREAK — NOT FACTORY MOLD

This repo is a disposable test copy of fatguylilcoat98/AI-companion-GNG.
The factory mold remains canonical.
Real client data must never enter this repo.
This repo may be deleted and recloned at any time.

## Identity

- **Repo:** fatguylilcoat98/clasp-endor
- **Role:** disposable test instance / safe-to-break copy
- **Source:** fatguylilcoat98/AI-companion-GNG (factory mold, untouched)
- **Working branch for test-door work:** `test-instance`

## Rules for this repo

- May be wiped, polluted with test data, broken, deleted, recloned.
- No real client data, ever.
- No production credentials, ever.
- No pushes from this repo back to the factory mold.
- No runtime testing against the mold database.

## If you are looking for the canonical platform

Go to fatguylilcoat98/AI-companion-GNG. This repo is not it.

## Test-door UI

This repo ships a minimal local web UI to break against. It is **not**
in the factory mold and must not be back-ported.

Start it locally (after provisioning your local DB and filling `.env`):

    npm run start:web

Then open http://localhost:3000.

### Provisioning the local test pilot

1. Copy `config/answers.example.json` to `config/test-door.answers.json`
   (gitignored) and fill in placeholder values — these are non-real
   labels only.
2. Set `LYLO_SETUP_DATABASE_URL` to your local Postgres URL (must
   resolve to `localhost` / `127.0.0.1`).
3. Run:

       npm run seed:test-door -- --answers config/test-door.answers.json

4. Paste the three printed `export` lines into your `.env`:
   `LYLO_PILOT_INSTANCE_ID`, `LYLO_TEST_SENIOR_USER_ID`,
   `LYLO_TEST_ADMIN_USER_ID`.
5. Fill `ANTHROPIC_API_KEY`, `WEB_SESSION_SECRET` (any random >= 16
   chars), and the three DB URLs.
6. Set `LYLO_WEB_MODE=true`.

The web entry refuses to boot unless every DB URL resolves to
`localhost` / `127.0.0.1`. This is a hard stop — the test door must
never connect to a remote database, including the factory mold's.

### Test-door scope (deliberately minimal)

- One pilot, one senior user, one admin user — seeded locally.
- One chat surface, one governance/audit panel, one admin ring buffer.
- Real Anthropic call; no mock model on the chat path.
- No mutation controls, no repair/retry/reconciliation actions.
- No new substrate tables, no new governance actors, no new ctx
  operations, no `EVENT_TYPES` widening. The mold's substrate is
  consumed read-only through existing public surfaces.

### Running the test door on a remote Postgres (Render only)

The test door fails closed on any non-localhost DB URL by default. To
allow a Render-hosted Postgres for the disposable test instance, set
**all three** of these flags on the same process:

- `GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true`
- `LYLO_WEB_MODE=true`
- `LYLO_SHELL_MODE=true`

Any one missing → boot refuses to start. The mold's boot path does
not consult this flag.

#### One-time setup on Render

1. Provision a Render Postgres instance, copy the **External Database
   URL** (it includes `?sslmode=require`).
2. In Render's service shell, run:

       LYLO_SETUP_DATABASE_URL='postgres://...sslmode=require' \
       GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true \
       LYLO_WEB_MODE=true \
       LYLO_SHELL_MODE=true \
       npm run migrate:test-door

   Re-runnable safely — already-applied migrations are reported and
   skipped (pg codes `42P07` / `42710` etc.).

3. Then seed the pilot + users (zero arguments needed; uses built-in
   placeholder labels):

       LYLO_SETUP_DATABASE_URL='postgres://...sslmode=require' \
       GNG_TEST_INSTANCE_ALLOW_RENDER_DB=true \
       LYLO_WEB_MODE=true \
       LYLO_SHELL_MODE=true \
       npm run seed:test-door

   Output ends with three lines like:

       LYLO_PILOT_INSTANCE_ID=<uuid>
       LYLO_TEST_SENIOR_USER_ID=<uuid>
       LYLO_TEST_ADMIN_USER_ID=<uuid>

   Re-running the seed against an already-provisioned pilot prints
   the existing IDs (it does not duplicate rows).

#### Render environment variables (test-door service)

Set every variable below on the Render service. Real values; never
commit them.

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | The Anthropic API key for the test door. |
| `LYLO_APP_DATABASE_URL` | yes | Render External Database URL with `?sslmode=require`. |
| `LYLO_RUNTIME_DATABASE_URL` | optional | Not used by `start:web`; safe to set to the same Render URL for consistency. |
| `LYLO_SETUP_DATABASE_URL` | seed-only | Same Render URL; needed when running `migrate:test-door` or `seed:test-door`. |
| `LYLO_PILOT_INSTANCE_ID` | yes | UUID printed by `seed:test-door`. |
| `LYLO_TEST_SENIOR_USER_ID` | yes | UUID printed by `seed:test-door`. |
| `LYLO_TEST_ADMIN_USER_ID` | yes | UUID printed by `seed:test-door`. |
| `LYLO_SHELL_MODE` | yes | Must be `true` for the Render escape hatch to engage. |
| `LYLO_WEB_MODE` | yes | Must be `true` — gates the web entry point. |
| `GNG_TEST_INSTANCE_ALLOW_RENDER_DB` | yes | Must be `true` — gates the non-localhost rule. |
| `WEB_SESSION_SECRET` | yes | Random string, length >= 16. Rotate by changing the value. |
| `PORT` | yes | `10000` for Render's default web service port. |

Render service start command:

    npm run start:web

This is a test door. Real client data must never enter this instance.
Delete and recreate at any time.
