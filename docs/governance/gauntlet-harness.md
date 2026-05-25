# Gauntlet Harness

**Applies to:** the `src/gauntlet/` test-only library, the
`tests/gauntlet/scenarios/*.json` versioned scenario catalog,
the `tests/gauntlet/manual/` gitignored local-sandbox directory,
the `tests/gauntlet/runner.test.js` driver, and the
`scripts/ci/check-gauntlet-boundary.js` boundary guard.
Introduced in GM-30 — the first GM since the process lock that
is **not a substrate**.

**Status:** locked. Changes to the locked vocabularies
(`SCENARIO_CATEGORIES`, `STEP_KINDS`, `SETUP_OPS`,
`FORGERY_PATTERNS`, `EXPECT_RESULTS`, `LAYERS`,
`COUNCIL_CLASSIFICATIONS`) require paired updates to this
document, `src/gauntlet/schema.js`, and the L37 snapshot in
`tests/governance/adversarial.test.js`. **Removing any of the
four required sections (`## What this is`, `## What this is
NOT`, `## Council workflow`, `## Forbidden capabilities`) fails
the L27 doc-presence canary.**

**Depends on:** `substrate-freeze.md` (the freeze the harness
enables), `actor-runtime-boundary.md`, `governance-runtime-boundary.md`,
and every per-substrate runtime-boundary doc (the harness
exercises all eight Decision-gated actors).

## What this is

The gauntlet is the **adversarial testing harness** for the
seven-stage governance substrate. It exists to make the
question *"what happens if an attacker (or a confused good-
faith caller) does X?"* mechanical and reproducible.

A gauntlet scenario is a JSON object that:

1. Declares a session (pilot, user, role).
2. Sets up a deterministic chain state through named
   `chain.through.*` helpers (no raw SQL, no ad-hoc inserts).
3. Performs one named step (an `actor-call`, a forged-Decision
   construction, a classifier call, or a static-scan probe).
4. Declares the expected result (`expected_admission`,
   `expected_rejection`, `expected_throw`, `expected_no_op`),
   the expected architectural layer the rejection lands at,
   and an optional regex against the typed error class.

The runner loads every JSON file under
`tests/gauntlet/scenarios/` and asserts the actual result
matches the declared expectation. A scenario that fails CI is
either:

- a substrate regression (the substrate stopped refusing
  something it used to refuse), OR
- a test bug (the scenario's expectation drifted from reality).

In both cases the council classifies, and the classification
becomes part of the test output for paste-back review.

## What this is NOT

The gauntlet is NOT, and must never become:

- **a production code path.** `src/gauntlet/` is structurally
  forbidden from being imported by `src/runtime/`,
  `src/companion/`, `src/conversation/`, `src/memory/`,
  `src/governance/`, `src/actors/`, or `src/review/`. The
  six existing boundary guards have been extended with explicit
  reciprocal forbids per OQ-30.12.
- **a way to bypass actors / classifiers / RLS.** The harness
  consumes ONLY the public surfaces: `src/governance/`,
  `src/actors/`, and `src/review/`'s top-level entries. The
  `check-gauntlet-boundary.js` import allowlist is the
  mechanical enforcement.
- **a way to issue raw SQL.** Per OQ-30.6(b), raw-SQL
  adversarial probes live in `tests/integration/*.test.js`
  where they belong (alongside the existing GRANT-denial
  tests). The gauntlet is for **public-surface** probes.
- **a way to call the model SDK.** `@anthropic-ai/sdk` is on
  the boundary-guard forbidden module list.
- **an HTTP server, a scheduler, a worker, a child process.**
  Each is on the forbidden module / identifier list.
- **a memory-mutation pathway.** The harness never writes
  memory rows (it has no SQL keyword to do so, and the
  `insertPrivateMemory` identifier is on the forbidden list).
- **a fixture creator.** The harness re-applies the existing
  `tests/rls-contract/fixtures.sql` per scenario; it does NOT
  define new fixture rows. Adding a new fixture row is a
  paired-change decision gate.
- **a substrate.** GM-30 added zero new tables, zero new
  actors, zero new ctx operations, zero new vocabulary
  entries. The L22 substrate-freeze canary mechanically
  enforces this.
- **a CI-skip mechanism.** Versioned scenario failures block
  CI per OQ-30.8(a). Flaky scenarios are bugs, not features.
- **a way to introduce session-level state that survives
  between scenarios.** Every scenario re-applies the schema
  and fixtures via `fixtures.reset` (per OQ-30.5).

## Council workflow

The gauntlet is built around a four-step copy-paste loop.

### Step 1 — Adversarial probe arrives in chat

A council member writes a probe in plain English:

> "What if a non-admin user passes a real Decision but tries
> to record an outcome?"

### Step 2 — Translate into a scenario JSON

Claude (or any council member) translates the English probe
into a scenario JSON file. If the probe is exploratory, it
goes under `tests/gauntlet/manual/` (gitignored, never
auto-run, requires the explicit `GAUNTLET_MANUAL=1`
environment variable). If the council
classifies the probe as canonical, it gets promoted to
`tests/gauntlet/scenarios/` with a stable `id`.

The scenario format is locked. See `src/gauntlet/schema.js` for
the validator. The JSON must declare:

- `id` (unique across the catalog),
- `version` (literal `"1.0.0"` for GM-30),
- `category` (one of the 12 locked categories),
- `description` (human-readable, council-facing),
- `session` (pilotInstanceId, userId, userRole),
- `setup` (array of setup ops drawn from the 7 locked
  `SETUP_OPS`),
- `step` (one of `actor-call`, `forged-decision`,
  `classifier-call`, `static-scan`, `boundary-guard`,
  `snapshot-check`),
- `expect` (the expected `result`, `layerHit`, and
  `errorClassMatches` regex).

A malformed scenario fails fast at validation; it never
reaches the harness's dispatch layer.

### Step 3 — Run the scenario and capture the structured result

```sh
DATABASE_URL=postgres://.../lylo_rls \
LYLO_APP_DATABASE_URL=postgres://lylo_app_login:.../lylo_rls \
GAUNTLET_MANUAL=1 \
node --test --test-concurrency=1 tests/gauntlet/runner.test.js
```

The harness uses an environment variable rather than a CLI flag
because `node --test` does not propagate extra `argv` entries
to child test processes — the original `--manual` flag was
silently dropped. `GAUNTLET_MANUAL=1` survives the spawn and
L38 mechanically asserts the env-var contract.

The runner emits one result JSON per scenario. The result is
**structurally locked** — only typed fields, no payload echo,
no error message bodies. Council can paste the result into any
review channel without leaking content.

### Step 4 — Classify the result

The council picks one of nine classifications (per
constitutional addendum 9 + the L37 vocabulary lock):

| Classification | Meaning |
|---|---|
| `expected_rejection` | Substrate refused as expected. Healthy. Likely → promote scenario from `manual/` to `scenarios/`. |
| `expected_admission` | The substrate ADMITTED an operation that the scenario predicted should be admitted. Healthy. |
| `test_bug` | The scenario's expectation was wrong (wrong layer, wrong error class regex). Fix the scenario. |
| `fixture_bug` | The seed data doesn't support the probe (e.g. the scenario references an outcome ID that the fixtures don't seed). Fix the fixture or the scenario. |
| `substrate_bug` | The substrate had a hole — refused at the wrong layer, accepted something it should refuse, or admitted with wrong shape. Opens a fix-PR decision gate. |
| `invariant_violation` | The substrate violated a constitutional invariant (e.g. EVENT_TYPES widened, `verified_*` leaked into outcome vocab). STOP, escalate to inspection-only mode. |
| `missing_architecture` | The probe identifies a category of attack the substrate doesn't even attempt to defend against. Opens a NEW inspection-only GM decision gate (subject to the substrate freeze — see `substrate-freeze.md`). |
| `classified_pending` | Council has not yet reached consensus on classification. Result remains in chat for further review. |
| `no_action_needed` | The probe is interesting but does not change the substrate; archive without action. |

A scenario promoted from `manual/` to `scenarios/` joins the
CI gauntlet suite permanently. From that point forward, every
PR proves the substrate continues to refuse that specific
adversarial input.

## Forbidden capabilities

The harness is mechanically forbidden from:

| Capability | Enforcer |
|---|---|
| `require('pg')` | `check-gauntlet-boundary.js` |
| `require('@anthropic-ai/sdk')` or any other model SDK | `check-gauntlet-boundary.js` |
| `require('http' / 'https' / 'express' / 'fastify' / 'koa' / '@hapi/hapi')` | `check-gauntlet-boundary.js` |
| `require('child_process' / 'worker_threads' / 'cluster')` | `check-gauntlet-boundary.js` |
| `require('../runtime/...' / '../db/...' / '../setup/...' / '../memory/...' / '../companion/...' / '../conversation/...')` | `check-gauntlet-boundary.js` |
| `require('../review/repository' / '../review/transaction' / '../review/client')` (only `'../review'` / `'../review/index'` allowed) | `check-gauntlet-boundary.js` |
| `require('../governance/<deeper>')` (only `'../governance'` / `'../governance/index'` allowed) | `check-gauntlet-boundary.js` |
| `require('../actors/<deeper>')` (only `'../actors'` / `'../actors/index'` allowed) | `check-gauntlet-boundary.js` |
| Any SQL keyword in code (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/REVOKE/CREATE/SELECT/FROM/JOIN/WHERE) | `check-gauntlet-boundary.js` |
| `insertPrivateMemory` identifier | `check-gauntlet-boundary.js` |
| The 7 bare identifiers `bypass`, `skip`, `disable`, `override`, `force`, `monkeypatch`, `monkey_patch` (L24) | `check-gauntlet-boundary.js` + L24 |
| `fs.writeFile` / `fs.appendFile` / `fs.createWriteStream` / `fs.mkdir` / `fs.rm` / `fs.unlink` and Sync variants | `check-gauntlet-boundary.js` |
| `setInterval` / `setImmediate` / `cron` / `schedule` | `check-gauntlet-boundary.js` |
| Reaching into `_BLESSED` / `_TOKEN` / `_createDecision` in `src/governance/decisions.js` | The classifier does not export them; the harness cannot acquire them through any allowed path |
| Direct writes to `governance_audit_log` | The harness has no SQL keyword; the audit module owns that table |
| Manual scenario auto-loading without `GAUNTLET_MANUAL=1` env var | L38 + the runner |
| Importing `src/gauntlet/` from any production module | The six reciprocal boundary guards + `check-gauntlet-boundary.js` |
| Adding a new actor, table, ctx op, EVENT_TYPES value, or vocabulary entry | L22 substrate-freeze canary |

## Change control

Locked. Adding a new gauntlet capability requires paired
updates to:

- this document,
- `src/gauntlet/schema.js` if the change touches the locked
  vocabularies,
- `scripts/ci/check-gauntlet-boundary.js` if the change
  touches the forbidden vocabulary / import allowlist / SQL
  ban / scheduling ban / fs ban,
- `tests/governance/adversarial.test.js` (L37 if vocabulary,
  L24 if forbidden-vocab list, L38 if manual-mode rule),
- `docs/governance/baseline-ci.md` if the change adds a new
  CI job or modifies an existing one.

Adding a new category to `SCENARIO_CATEGORIES`, a new step
kind, a new forgery pattern, a new layer label, or a new
council classification is a vocabulary change subject to L37.

**No new substrate.** Per `substrate-freeze.md`, GM-30 does not
expand the substrate, and the gauntlet exists precisely so the
council can prove the substrate is comprehensive WITHOUT adding
new substrate. If a scenario surfaces a missing architecture,
the classification is `missing_architecture`, and the response
is a NEW inspection-only GM — not a paired-change patch.

## Cross-references

- `substrate-freeze.md` — the freeze this harness enables.
- `actor-runtime-boundary.md` §2 — the 8 actor factories the
  harness drives.
- `governance-runtime-boundary.md` — the classifier the
  harness invokes.
- `rls-privacy-contract.md` — the RLS contract the harness
  proves end-to-end.
- `baseline-ci.md` — the CI guard set (now 14 guards).
- `../../scripts/ci/check-gauntlet-boundary.js` — the guard.
- `../../src/gauntlet/` — the library.
- `../../tests/gauntlet/scenarios/` — the 12 versioned probes.
- `../../tests/gauntlet/manual/` — the gitignored local
  sandbox.
- `../../tests/gauntlet/runner.test.js` — the driver.
- `../../tests/governance/adversarial.test.js` — L14 (sentinel
  scan on result), L15 (EVENT_TYPES freeze), L22
  (substrate-freeze canary), L24 (gauntlet forbidden vocab),
  L27 (this doc-presence canary), L37 (vocabulary snapshot),
  L38 (manual-mode refusal).
