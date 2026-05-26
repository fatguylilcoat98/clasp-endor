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

- One pilot, real auth users (one per signup), seeded admin via
  `LYLO_BOOTSTRAP_ADMIN_EMAILS`.
- One chat surface, one governance/audit panel, one admin ring buffer.
- Real Anthropic call; no mock model on the chat path.
- No mutation controls, no repair/retry/reconciliation actions.
- No new governance actors, no new ctx operations, no `EVENT_TYPES`
  widening. The mold's substrate is consumed read-only through
  existing public surfaces.

### Path 2 identity / Supabase Auth

Pre-auth, the test door mapped every "regular" login to one
hardcoded senior UUID — collapsing distinct humans into one
substrate identity. Path 2 wires Supabase Auth so each signup
produces a distinct `public.users` row keyed on `auth_user_id`.
The substrate's existing RLS contract then narrows every memory
query by the resolved distinct user UUID. Mold and RLS layer
unchanged.

Required Render env vars (the new pieces from Step 1):

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | The Supabase project URL. Used by the server-side auth client and (verbatim) as the JWT expected issuer prefix. |
| `SUPABASE_ANON_KEY` | The Supabase anon key. Sent as the `apikey` header on signup/login REST calls. Server-side only; never shipped to the browser. |
| `SUPABASE_JWT_SECRET` | The HS256 secret Supabase signs access tokens with. The server verifies tokens locally — no per-request round-trip to Supabase. |
| `LYLO_BOOTSTRAP_ADMIN_EMAILS` | Comma-separated emails that auto-receive `role='admin'` on first signup. Promotion of existing users is intentionally NOT supported via this var — those go through a future admin flow. |
| `LYLO_SIGNUP_ALLOWLIST` | Optional. When set, only listed emails (or `*@domain.com` patterns — Step 2) may sign up. Empty/unset = open signup. **Flip this on the moment the deployment carries anything real.** The test door is currently open. |

Required Supabase project settings:

- **Auth → Settings → Confirm email**: ON (operator decision, recommended).
- **Auth → Email templates**: customize from defaults if/when going public.
- **Auth → Rate limits**: keep at defaults; server adds no additional throttle in Step 1 (Step 2 may add a coarse IP-level cap on `/api/login`).

Substrate change in Step 1:

- `db/migrations/017_auth_user_link.sql` adds `users.auth_user_id UUID UNIQUE` (nullable, partial index). Mirrored in `MASTER_MIGRATION.sql`. Apply once via `npm run migrate:test-door` (or the Supabase SQL editor) before deploying any code that uses the auth path. Legacy rows keep NULL and become unreachable through the new flow — operator may DELETE them after auth users exist if a clean slate is desired.
