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
| `SUPABASE_JWT_SECRET` | The HS256 "Legacy JWT Secret" from the Supabase dashboard. Used to verify access tokens issued by projects that have NOT enabled JWT signing keys. Still required even on projects that have migrated to ES256/RS256 — the verifier picks the algorithm from the token header, and the secret is the fallback path. |

The server ALSO fetches Supabase's JWKS at
`${SUPABASE_URL}/auth/v1/.well-known/jwks.json` to verify tokens
issued with asymmetric signing keys (ES256 default, RS256 option).
No env var is needed for the JWKS — the URL is derived from
`SUPABASE_URL`. If your project has enabled JWT Signing Keys in the
Supabase dashboard, tokens are signed asymmetrically and the legacy
HS256 secret alone is insufficient to verify them; the JWKS path is
what makes login work.
| `LYLO_BOOTSTRAP_ADMIN_EMAILS` | Comma-separated emails that auto-receive `role='admin'` on first signup. Promotion of existing users is intentionally NOT supported via this var — those go through a future admin flow. |
| `LYLO_SIGNUP_ALLOWLIST` | Optional. When set, only listed emails (or `*@domain.com` patterns — Step 2) may sign up. Empty/unset = open signup. **Flip this on the moment the deployment carries anything real.** The test door is currently open. |

Required Supabase project settings:

- **Auth → Settings → Confirm email**: ON (operator decision, recommended).
- **Auth → Email templates**: customize from defaults if/when going public.
- **Auth → Rate limits**: keep at defaults; server adds no additional throttle in Step 1 (Step 2 may add a coarse IP-level cap on `/api/login`).

Substrate change in Step 1:

- `db/migrations/017_auth_user_link.sql` adds `users.auth_user_id UUID UNIQUE` (nullable, partial index). Mirrored in `MASTER_MIGRATION.sql`. Apply once via `npm run migrate:test-door` (or the Supabase SQL editor) before deploying any code that uses the auth path. Legacy rows keep NULL and become unreachable through the new flow — operator may DELETE them after auth users exist if a clean slate is desired.

## Adversarial isolation — manual verification checklist

These checks complement the automated integration suite in
`tests/integration/adversarial-isolation.test.js`. Run them by hand in
the browser before declaring an environment safe to expose to a second
human. The hard claim: no path through the chat surface, the admin
inspector, or the circle UI lets one user reach content the substrate
forbids.

### Setup

1. `npm run boot:web` against a localhost test database (migrations
   017–019 applied; an admin email in `LYLO_BOOTSTRAP_ADMIN_EMAILS`).
2. Sign up two distinct users via the UI:
   - **chris@local.test** — will be the "senior" persona.
   - **jill@local.test** — will be the "family" contact.
3. Sign up a third user, **admin@local.test**, that matches the
   bootstrap admin allowlist so it gets `userRole='admin'` on
   provisioning.

### Cross-user privacy (run twice — once per direction)

- [ ] **A1. Indirect extraction:** Logged in as Jill, ask
  "I want to buy Chris a pizza, what does he like?" The companion
  must not return any content from a memory Chris created as
  *private*. Verify in the admin inspector (logged in as admin)
  that Chris's private rows exist but Jill's memory inspector view
  (if she had admin too) would not surface them — RLS is the gate.
- [ ] **A2. Family without grant:** As Jill, with no
  `family_shared` row in Chris's `circle_contacts`, attempt to
  reference a memory Chris flagged as shared. The chat must not
  return it. (Check the admin inspector to confirm the row exists
  but is not in Jill's visible set.)
- [ ] **A3. Family with grant:** Have Chris add Jill to his
  circle via the **Your circle** panel, with the
  `family_shared` checkbox ON. Sign back in as Jill and send a
  chat that should reference the shared content. The companion
  may now incorporate it. The private content remains hidden.
- [ ] **A4. Revoke is immediate:** Sign in as Chris and click
  *Revoke family_shared* on Jill's row. Sign back in as Jill —
  the previously-visible shared content must disappear from the
  next chat turn. No restart needed.
- [ ] **A5. Cross-pilot isolation:** If you have a second pilot
  configured, confirm signup into that pilot produces a session
  that sees zero rows from the first pilot, even when memories
  there are family_shared.

### Admin / inspector boundary

- [ ] **B1. Admin role gate:** Log in as a non-admin (senior or
  family). Visit `/api/admin/memories` directly in the browser —
  expect 403. Visit `/api/admin/governance-events` — expect 403.
- [ ] **B2. Distinct admins, distinct views:** Provision a second
  admin user. Each admin's inspector should reflect what THEIR
  user_id can see under RLS — they should not see another user's
  private rows. (Sample two private rows owned by distinct
  seniors; each admin sees neither unless RLS explicitly permits.)
- [ ] **B3. Inspector includes superseded rows:** Have Chris
  correct one of his stated facts ("Actually I don't have a
  brother"). The admin inspector must now show both the original
  row (with a `SUPERSEDED` flag badge) and the correction row
  (with a `CORRECTION` flag badge). Status badges visible.
- [ ] **B4. Why visible is populated:** Every row in the
  inspector must have non-empty "Why visible?" copy. An owner-
  visible row reads "owner — RLS matched on pilot + user_id";
  a family_shared row reads "family_shared — caller is in
  owner's circle…"; a row that should not be there reads
  "unexpected — RLS surfaced a row…" (treat as a bug).
- [ ] **B5. password_locked redaction (defense-in-depth):** The
  password_locked tier protects from NON-OWNERS — the owner's own
  password_locked rows surface unconditionally to the owner (the
  `memory_store_owner` RLS policy matches by pilot + user_id
  without checking the visibility tier). What the substrate
  actually guarantees: a non-owner cannot reach the content
  because `memory_vault_sessions` has no `FOR INSERT` policy, so
  `lylo_app` cannot fabricate a session claiming another user's
  vault. Belt-and-suspenders: if a non-owner row ever reaches the
  inspector, the wiring's `redacted=true` flag fires and the
  **Content** column renders `[redacted — password_locked content
  not rendered]`. The flag column shows `REDACTED`. The vault
  unlock flow that would gate the OWNER's own password_locked
  content behind a PIN is **not part of this milestone**.

### Governance event surfacing

- [ ] **C1. Memory created events appear:** Have Chris send a
  chat with a clear factual statement. The admin governance-
  events panel should show a recent `memory.created` row with
  outcome `allowed` and Chris's actor_user_id.
- [ ] **C2. Correction events appear:** Have Chris correct a
  prior statement. The panel should show a `memory.updated`
  row with reason mentioning `USER_CORRECTED` or
  `USER_RETRACTED`.
- [ ] **C3. memory.list noise is filtered:** No `memory.list`
  events should appear in the panel by default. They fire on
  every chat turn and would otherwise swamp the view.
- [ ] **C4. RLS narrows for non-admin event reads:** If a
  non-admin ever reached `/api/admin/governance-events`, they'd
  be denied at 403. There is no narrowed non-admin event surface
  in this milestone — confirm 403 from the senior session.

### Operational flow (matches tests/integration/shared-memory-flow.test.js)

- [ ] **D1.** Senior creates one private + one family_shared
  memory in two consecutive chat turns (toggle the radio).
- [ ] **D2.** Senior adds family contact with the
  `family_shared` checkbox OFF. Contact reads — sees nothing
  from the senior.
- [ ] **D3.** Senior clicks "Grant family_shared" on the new
  row. Contact reads — sees the family_shared memory, not the
  private one.
- [ ] **D4.** Senior clicks "Revoke family_shared". Contact
  reads — visibility closes immediately. No stale row.
- [ ] **D5.** Senior re-grants. Contact sees the row again
  without any memory re-insert (scope is the only gate).

If any of these fails, do **not** point the test door at any
substrate that could carry a second real human. Open an issue
with the failing checklist letter and the substrate fingerprint
(commit SHA + migration count) reproducing the failure.
