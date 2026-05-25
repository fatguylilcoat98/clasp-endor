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
