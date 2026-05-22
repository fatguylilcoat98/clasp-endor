# Companion Configuration & Abstraction Boundary

**Applies to:** the companion platform — this master template and every
companion instance copied from it.
**Status:** the boundary is fixed. The configuration *values* for a given
instance are a deployment-owner decision (see `owner-decisions-template.md`).
**Depends on:** `governance-vocabulary-lock.md`, `source-of-truth-memory-policy.md`,
`feature-flag-model.md`, `../setup/template-boundaries.md`.

## Purpose

This document draws the line between **what belongs to the platform
forever** and **what belongs to each companion instance**. It exists so
that application code extracted into the master in later GM-series PRs
has a contract to extract *against* — the master must stay generic, and
nothing about one companion may be hardcoded.

It answers one question:

> What is universal and hardcoded, and what must be configurable per
> instance?

Three principles govern every rule below.

1. **The platform floor is hardcoded.** Governance, memory policy,
   audit, privacy, provenance, vault behavior, the Setup framework, and
   deployment safety are platform-level and identical in every instance.
2. **Companion identity is data, never code.** A companion's name,
   voice, and personality are per-instance configuration — they are
   never compiled into the master.
3. **Configuration is additive-restrictive only.** Configuration may
   make a companion *more* cautious; it may never make it less cautious
   than the platform floor.

## 1. Platform behavior — universal, hardcoded

The following is identical in every companion instance. It is not
configurable, and no configuration source may weaken it.

- **Governance rules** — the locked vocabulary and the governed-context
  rules (`governance-vocabulary-lock.md`).
- **Memory policy** — the source-of-truth memory policy in full
  (`source-of-truth-memory-policy.md`).
- **Audit behavior** — the append-only governance audit log; every
  sensitive access is logged.
- **Privacy boundaries** — new memory defaults to `private`; raising
  visibility is explicit and authority-validated.
- **Setup framework** — the Setup Mode flow and the `setup_state`
  machine. *Which* steps an instance runs is configurable; the framework
  is not.
- **Vault behavior** — the plaintext vault secret never reaches the
  database; lockout is enforced by the platform. The *values* (PIN
  length, lockout threshold and duration) are configurable.
- **Admissibility / provenance rules** — the locked three-class
  provenance model and the rule that model output cannot self-promote.
- **Deployment safety rules** — the feature-flag model, fail-closed
  startup, and the RLS enforcement model (`feature-flag-model.md`).

## 2. Companion-specific behavior — configurable per instance

The following describes how one companion *sounds and behaves within*
the platform floor. All of it is configurable, and all of it ships
**blank or at a safe default** in the master.

- Companion name.
- Tone and personality.
- Speaking style.
- Supported-person name and preferences (stored on the
  supported-person profile, not in companion configuration).
- Cultural and faith tone — controlled, default `none`.
- Family and caregiver terminology — wording only.
- Allowed / disallowed topics — instance restrictions *added on top of*
  the platform floor.
- Voice settings — enabled, voice id, speaking rate.
- Reminder style — presentation tone and frequency.
- Emotional boundaries — warmth, escalation-on-distress.
- Escalation preferences — preferred channel and ordering.

## 3. Platform vs companion boundary table

| Concern | Platform-forever (hardcoded) | Companion-specific (configurable) | Where it lives |
|---|---|---|---|
| Governance rules | Vocabulary lock, governed-context rules | — | code + `governance-vocabulary-lock.md` |
| Memory policy | Source-of-truth policy in full | — | code + `source-of-truth-memory-policy.md` |
| Provenance / admissibility | 3-class model, no self-promotion, immutability | — | schema (`004`) + code |
| Audit behavior | Append-only log; all sensitive access logged | — | schema (`005`) + code |
| Privacy boundaries | Default `private`; explicit-sharing-only | Circle *membership* per instance | schema + code / `circle_contacts` |
| Vault behavior | Plaintext-never-to-DB; lockout mechanism | PIN length; lockout threshold / duration | code / owner decision |
| Setup framework | The Setup Mode flow + `setup_state` machine | Which steps an instance runs | code + `setup_state` |
| Deployment safety | Feature-flag model; fail-closed; RLS model | Flag names / defaults / order per instance | code + environment variables |
| Companion name | — | Configurable | `companion_profile.companion_name` |
| Tone / personality | — | Configurable | `companion_profile.persona` |
| Speaking style | — | Configurable | `companion_profile.persona` |
| Cultural / faith tone | — | Configurable (default `none`) | `companion_profile.persona` |
| Allowed / disallowed topics | Platform floor of disallowed topics | Instance may *add* restrictions | `companion_profile.persona` |
| Voice settings | The voice subsystem | Enabled, voice id, rate | `companion_profile.voice` + `VOICE_ENABLED` flag |
| Reminder style | The reminder subsystem | Presentation tone / frequency | `companion_profile` |
| Emotional boundaries | "Companion, not clinician" floor | Warmth; escalation-on-distress | `companion_profile` |
| Escalation preferences | That escalation exists and is audited | Preferred channel; ordering | `companion_profile` + `circle_contacts` |
| Family / caregiver terminology | — | Wording only | `companion_profile.terminology` |
| Supported-person name / preferences | — | Configurable | `supported_person_profile` |

**Rule of thumb.** If changing it would change the platform's
*guarantees*, it is platform-forever. If it only changes how one
companion *sounds or behaves within those guarantees*, it is
companion-specific.

## 4. Configuration sources

Each concern has exactly one authoritative source. Sources do not
compete.

| Source | Holds | Never holds |
|---|---|---|
| `config/companion.example.json` | The configuration **shape** and safe defaults; placeholder example values only | Real client values, secrets, the supported person's name |
| `companion_profile` (database) | The **live, authoritative** companion identity for a running instance | Secrets, feature-flag state |
| `supported_person_profile` (database) | The supported person's durable record (display name, timezone, locale, preferences) | Companion persona, governance state |
| `setup_state` (database) | Onboarding **progress** — which steps are complete | Configuration *values*; it tracks process, not content |
| Environment variables | Feature flags (Layer 1/2/3), secrets, infrastructure / deployment config | Persona text, companion identity, human-readable configuration |
| Future admin UI | An **editing surface** that writes `companion_profile` / `supported_person_profile` | A parallel store; it is a view onto the database tables, not a new source |

### Decided source rules

- **`companion_profile` is the sole runtime source** for a deployed
  instance's companion identity (owner decision OQ-4.1).
- **`config/companion.example.json` is a shape reference, a Setup seed,
  and a template artifact only.** It is *not* a competing runtime
  source. A deployed instance never reads it as live configuration.
- **The companion configuration file is about the AI.** The supported
  person is never in it — that person lives only in
  `supported_person_profile`.
- **`setup_state` is a state machine, not a config store.**
  Configuration values must never leak into it.

## 5. Companion configuration schema (proposed shape)

This is the proposed shape for `companion.json`. The master ships it as
`config/companion.example.json` with placeholder values. The formal
machine-readable schema — JSON Schema draft 2020-12 — is delivered in
GM-5 (owner decision OQ-4.5); GM-6 adds a validator that enforces it.

The supported person is **deliberately absent** from this shape.

```jsonc
{
  "schema_version": "1.0",
  "_comment": "Example only. Real values are created in Setup Mode and stored in companion_profile.",
  "companion": {
    "name": "",                       // REQUIRED — blank until Setup
    "persona": {
      "tone": "",                     // REQUIRED — blank until Setup
      "speaking_style": "",           // REQUIRED — blank until Setup
      "values": [],                   // optional
      "warmth_level": "standard",     // enum: reserved | standard | warm
      "cultural_tone": "none",        // controlled enum — default "none"
      "cultural_notes": "",           // optional free-text explanation
      "faith_tone": "none",           // controlled enum — default "none"
      "faith_notes": ""               // optional free-text explanation
    },
    "topics": {
      "disallowed": [],               // controlled vocabulary — ADDS to the platform floor
      "encouraged": [],               // controlled vocabulary
      "notes": ""                     // optional free-text explanation
    },
    "voice": {
      "enabled": false,               // default false
      "voice_id": "",                 // REQUIRED only when enabled
      "speaking_rate": "normal"       // enum: slow | normal
    },
    "reminders": {
      "style": "gentle",              // enum: gentle | neutral | brisk
      "frequency": "as_scheduled"     // enum: as_scheduled | minimal
    },
    "emotional_boundaries": {
      "escalation_on_distress": true, // default true — may not be set below the platform floor
      "comfort_role": "supportive_companion"  // fixed vocabulary; never "therapist" / "clinician"
    },
    "escalation": {
      "preferred_channel": "circle",  // enum: circle | operator
      "contact_order": []             // references circle_contacts; holds no personal data
    },
    "terminology": {
      "family_term": "family",
      "caregiver_term": "caregiver",
      "supported_person_term": "the person you support"
    },
    "safety": {
      "posture": "standard"           // enum: standard | heightened — never below standard
    }
  }
}
```

### Field rules

| Rule | Detail |
|---|---|
| Required | `name`, `persona.tone`, `persona.speaking_style`; `voice.voice_id` only when `voice.enabled` is true |
| Safe defaults | `voice.enabled = false`; `safety.posture = "standard"`; `escalation_on_distress = true`; every tone enum at its most conservative value |
| Blank-until-Setup | Every free-text identity field — `name`, persona text, `voice_id`, terminology overrides — ships **empty** in the master |
| Controlled vocabulary | `topics.disallowed` / `topics.encouraged` use a controlled vocabulary, with an optional `notes` field for free-text explanation (owner decision OQ-4.2) |
| Controlled enums | `cultural_tone` and `faith_tone` are controlled enums, default `none`, each with an optional `*_notes` free-text field (owner decision OQ-4.3) |
| Enum validation | Every enum field is validated against a fixed set; an unknown value is invalid configuration |
| Restrictive-only | `topics.disallowed` may only *add*; `safety.posture` may only go *up*; `escalation_on_distress` may not be disabled |
| Forbidden keys | No key may name a governance, audit, provenance, privacy, or RLS control — those are not configurable (see section 7) |
| `schema_version` | Required; lets the GM-6 validator and future schema migrations key off it |

### Controlled vocabularies and enums

The exact tokens for the controlled vocabularies (`topics.*`) and the
controlled enums (`cultural_tone`, `faith_tone`) are **finalized in
GM-5** with the JSON Schema. Two design constraints bind GM-5:

- The value sets are **small and neutral**. `cultural_tone` and
  `faith_tone` describe the companion's *posture toward* culture and
  faith — not a specific culture or religion. A specific practice, if
  any, is recorded in the `*_notes` free-text field during Setup Mode,
  never as a master default.
- `topics.disallowed` *adds to* the platform floor. The platform already
  forbids categories universally (see section 7); an instance's
  `disallowed` list narrows behavior further and can never widen it.

## 6. Runtime loading model

Configuration is resolved **per concern**. Each concern has exactly one
authoritative source; there is no single global override stack.

| Concern | Authoritative source | Fallback |
|---|---|---|
| Feature flags (Layer 1/2/3) | Environment variables | Model defaults — every flag `false` |
| Secrets / infrastructure | Environment variables | None — missing is fail-closed |
| Companion identity & persona | `companion_profile` (database) | Schema defaults for *optional* fields only |
| Supported-person record | `supported_person_profile` (database) | None for required fields |
| Platform floor | Hardcoded in code | Not overridable — see section 7 |

### Boot sequence

1. Read the environment and resolve the feature flags. If the **Layer-1
   master switch is `false`**, the runtime stays inert
   (`feature-flag-model.md`) — no profile is loaded. Stop here.
2. Layer-1 is `true` — load `companion_profile` and
   `supported_person_profile` for the `pilot_instance_id`.
3. Validate the loaded profile against the schema (section 5).
4. **A required field is missing or invalid** — **fail-closed.** The
   runtime does not serve companion behavior; it surfaces a
   "setup incomplete" state and routes to Setup Mode (`setup_state`). It
   must **never** boot with a guessed or default persona.
5. **An optional field is absent** — apply the schema's safe default.
6. **A required secret or infrastructure variable is missing** —
   fail-closed.

### Failure principle

**Fail-closed, never fail-open.** A misconfigured companion is an inert
companion, not an improvised one. `config/companion.example.json` is a
shape reference and a Setup seed — it is never authoritative for a live
instance, and the runtime never silently substitutes its placeholder
values for missing real configuration.

## 7. Safety requirements — what configuration may never override

No configuration source — file, database, environment, or the future
admin UI — may weaken any of the following. The GM-6 validator must
reject any configuration that attempts it.

- **Provenance rules** — the locked three-class model; no
  `AI_INFERRED` to `VERIFIED_FACT` self-promotion.
- **Audit requirements** — the append-only log; every sensitive access
  is logged.
- **Privacy defaults** — new memory is `private`; sharing is explicit
  and authority-validated.
- **No-fabrication rule** — the companion may not invent and persist a
  claim that no source asserted.
- **Medical and legal boundaries** — the companion is a supportive
  companion, not a clinician or a lawyer. No configuration may cast it
  as one or have it issue medical or legal directives.
- **User-data protections** — memory immutability, retraction rather
  than deletion, the plaintext vault secret never reaching the database,
  and the RLS enforcement model.

**Enforcement stance.** Configuration is **additive-restrictive only.**
It may narrow behavior — a stricter safety posture, more disallowed
topics — but it may never widen behavior past the platform floor. The
floor lives in code and schema; configuration sits above it and cannot
reach below it.

## 8. Mattie contamination watchlist

The master is extracted from the lessons of the Mattie reference
system, never from its data or its one-off persona
(`../setup/template-boundaries.md`). The following Mattie-specific
assumptions must **never** enter the master. Each later extraction PR is
checked against this list.

| # | Contaminant | Correct generic form |
|---|---|---|
| C1 | `MATTIE_SOUL`, or any hardcoded soul / persona constant | `companion_profile.persona`; blank in the master |
| C2 | `"Mattie"` as a default or fallback companion name | `companion_name` is required from Setup; the example uses `"Example Companion"` |
| C3 | `"Sandy"`, or any real supported-person name or value | `supported_person_profile`; never in the master, never a default |
| C4 | Faith-specific phrasing baked into prompts | `persona.faith_tone`, default `none`; specifics in `faith_notes` at Setup |
| C5 | Scam or fraud narratives tied to a specific incident | Generic, configurable `topics.disallowed` and escalation; no hardcoded story |
| C6 | Specific family-member names or relationship assumptions | `circle_contacts` rows plus `terminology`; prompts use placeholders |
| C7 | Helper functions named or scoped to one use case | Generic functions, parameterized by `pilot_instance_id` |
| C8 | Prompt strings assuming one person or one family structure | Terminology-driven templating; no singular-relative assumption |
| C9 | Hardcoded timezone or locale | `supported_person_profile.timezone` / `.locale` |
| C10 | Render or Supabase service names referencing Mattie | Placeholders only |
| C11 | Cultural defaults presented as universal | Explicit `cultural_tone` configuration; neutral default |

## Downstream

- **GM-5** ships `config/companion.schema.json` — the JSON Schema
  (draft 2020-12) for the shape in section 5 — and revises
  `config/companion.example.json` to conform to it.
- **GM-6** adds a configuration validator and a baseline-CI job that
  validates `companion.example.json` against the schema.

Application-code extraction from the Mattie reference system begins only
after GM-6, against the boundary ratified here.

## Cross-references

- `governance-vocabulary-lock.md`, `source-of-truth-memory-policy.md`
- `feature-flag-model.md`, `owner-decisions-template.md`
- `../setup/template-boundaries.md`, `../setup/instance-copy-workflow.md`

## Change control

Locked. Changes are made by a reviewed change to this file, which lists
the documents and code paths affected.
