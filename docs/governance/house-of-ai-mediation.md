# House-of-AI mediation — architecture preparation

> **Status: architecture preparation only.** This document describes
> the intended mediation model for when multiple AI systems
> (companions, orchestrators, future analytics layers) coexist on top
> of the governed substrate. No mediation code exists yet. **No
> orchestrator should be built until this document is reviewed and a
> separate locked plan is approved.**

## The thesis

**The governance substrate is the asset. Companions and orchestration
are mounted applications.**

The substrate is what makes the platform trustworthy:

- multi-tenant isolation via `pilot_instance_id` + RLS,
- locked memory authority hierarchy (USER_CORRECTED outranks INFERRED),
- append-only `governance_audit_log`,
- the eight-stage Decision-gated actor model,
- the seven governance-staging artifact tables.

Companions (the clasp-endor test door, Mattie, any future companion)
are *consumers* of the substrate. They render UI, they wire AI models,
they shape conversational behavior — but they obtain visibility and
write authority *through* the substrate's public surfaces. They never
poke at memory_store directly. They never bypass the actor chain. They
never construct a Decision.

Orchestration is the future case where multiple companions or
analytics layers cooperate on the same supported person. The mediation
model below describes the rules that hold during that cooperation.

## Mediation model (future, not yet implemented)

### Rule 1 — No direct model-to-model propagation

When two AI systems share a supported person, they must not pass
state directly to each other.

```
WRONG:  CompanionA --(memory blob)--> CompanionB
RIGHT:  CompanionA --(governed write)--> substrate
                                          ↓
                CompanionB --(governed read)<-/
```

Why: direct propagation drops provenance. If A asserts "user said X"
and B accepts it as fact, the audit trail does not record that B's
belief came from A's inference rather than from the user. The
substrate's audit log is the only record that survives a companion
restart, a companion swap, or a companion failure.

### Rule 2 — All propagation routes through governed mediation

The substrate is the *only* path through which state crosses companion
boundaries. The path looks like:

```
companion → classifier → Decision → actor → memory ctx → DB → RLS
                                                             ↓
companion → classifier → Decision → actor → companion reader ←
```

Each arrow is auditable. Each Decision is unforgeable. Each ctx
operation generates an audit row. No companion ever observes another
companion's inference without it being a recorded memory with a known
provenance.

### Rule 3 — Provenance and authority are preserved between systems

When CompanionB reads a memory that CompanionA wrote, the
`authority_level` on the returned row is the source of truth. B's
prompt-building code respects the hierarchy from
`docs/governance/memory-authority-hierarchy.md`:

- A memory written by CompanionA as `EXTRACTED` does not become
  `USER_CONFIRMED` just because CompanionB reads it.
- A `USER_CORRECTED` write by CompanionA's user is binding on
  CompanionB's responses too.
- A `SUPERSEDED` row never appears in B's retrieval, just as it never
  appears in A's.

### Rule 4 — Uncertainty is preserved between systems

The `UNCERTAINTY_DIRECTIVE` in `src/conversation/prompt.js` is per-
companion today. When orchestration arrives, the directive should be
applied uniformly: a low-authority memory must not be presented to the
user with high confidence simply because it routed through a chain of
companions. The mediation layer enforces this by injecting the
authority_level into every cross-companion memory exchange, not just
the content.

### Rule 5 — Audit traceability across systems

A future audit query "who said this memory was true?" must answer
across orchestrators:

- `governance_audit_log.actor_user_id` records *which user* the write
  was attributed to.
- A future field (NOT YET ADDED) would record *which companion*
  performed the write on behalf of that user. Until that field
  exists, orchestration involving multiple companions on one
  supported person is **out of scope**.

## What this document does NOT authorize

- It does not authorize anyone to build the orchestrator described
  above. That is a separate, locked plan.
- It does not authorize a new `companion_id` column on
  `governance_audit_log`. That is a substrate change requiring a
  paired migration + boundary-guard update.
- It does not authorize a new "mediation actor". The eight existing
  actors cover today's needs; orchestration would require a paired
  new actor + paired Decision intent type + paired REASONS + paired
  classifier branch + paired docs update + paired adversarial tests.
- It does not authorize "models talking to models" without
  substrate mediation. If a future feature wants two models to
  cooperate, that cooperation goes through the substrate or it does
  not happen.

## Why this is doc-only right now

The hardening plan said: *"DO NOT build full orchestration yet. Only
prepare architecture cleanly."* Building the orchestrator without
this thesis written down would produce one of two predictable failure
modes:

1. The orchestrator would short-circuit the substrate ("just pass
   memories directly between companions, the substrate is too slow")
   — and we would discover three months later that audit history is
   wrong and no one knows which companion poisoned which fact.
2. The orchestrator would duplicate the substrate ("we need a
   message bus for inter-companion comms") — and we would discover
   that the message bus has its own RLS model, its own audit log,
   and its own bugs.

Writing this down first means future orchestration code starts from
the constraints: substrate mediates, audit preserves, authority
ranks. Companion code is mounted on those rules, not above them.

## When orchestration is approved

The opening checklist will be:

- [ ] Add `companion_id` column to `governance_audit_log` (paired
      migration, boundary-guard update, EVENT_TYPES unchanged).
- [ ] Add a `companion_registry` table or equivalent (separate
      migration, RLS-policy paired).
- [ ] Build the mediation actor (paired classifier branch + REASONS
      entry + adversarial test).
- [ ] Update this document to describe the implemented model.

Each of those is its own approved plan. None of them is in scope for
the hardening pass.
