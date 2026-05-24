# Documentation index

Documentation for the Lylo Companion golden master template.

## Setup

- `setup/instance-copy-workflow.md` — how to produce a new companion
  instance from this master.
- `setup/template-boundaries.md` — what must never enter the master.
- `setup/provisioning-contract.md` — the one-shot offline provisioning
  script, the answers file shape, idempotency rules, and the event
  catalog.

## Governance

- `governance/governance-vocabulary-lock.md` — locked definitions of
  every governance term.
- `governance/source-of-truth-memory-policy.md` — how a claim becomes,
  or is prevented from becoming, a trusted memory.
- `governance/feature-flag-model.md` — the staged-rollout feature-flag
  model.
- `governance/owner-decisions-template.md` — decisions a deployment
  owner records before creating an instance.
- `governance/baseline-ci.md` — what the baseline CI enforces, and what
  is scaffold / deferred.
- `governance/companion-configuration-boundary.md` — what belongs to the
  platform forever, and what is configurable per companion instance.
- `governance/companion-config-contract.md` — the machine-enforceable
  configuration contract: the JSON Schema, the physical mapping, and the
  validation modes.
- `governance/runtime-boundary.md` — the locked runtime boundary the
  configuration loader obeys, and the guards that enforce it.
- `governance/rls-privacy-contract.md` — the synthetic RLS / privacy
  contract: candidate policies, the DB-role model, and the
  session-variable convention that GM-15 will apply to the real
  schema.

## Deployment

- `deployment/operator-runbook.md` — operator runbook for the runtime
  shell: boot states, health/readiness behavior, structured log
  events, shutdown, local run commands, and failure-mode triage.
- `deployment/release-candidate.md` — the deployment-ready runtime-
  shell declaration: rehearsal evidence, scope, and explicit deferred
  items.
- `deployment/` — Render and Supabase readiness, environment variables,
  and the instance deployment guide. Populated by a later GM-series PR.

## Status

GM-14. The synthetic RLS / privacy contract is ported and
CI-enforced; the real RLS migration is the GM-15 gate. The Render /
Supabase portions of the `deployment/` section remain placeholders.
