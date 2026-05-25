# TEST INSTANCE — SAFE TO BREAK — NOT FACTORY MOLD

This repo is a disposable test copy of fatguylilcoat98/AI-companion-GNG.
The factory mold remains canonical.
Real client data must never enter this repo.
This repo may be deleted and recloned at any time.

See `TEST-INSTANCE.md` for full rules.

---

# ai-companion-gng — Lylo Companion Golden Master Template

This repository is the **golden master template** for the Lylo Companion
platform. It is the factory mold from which every client companion is
produced.

## What this repo is

- The clean, generic, reusable Lylo Companion platform.
- The single source from which new companion instances are created.
- Changed **only** when the platform improves for **all** future
  companions.

## What this repo is NOT

- It is **not** a live client deployment.
- It is **not** Mattie. Mattie (`mattie-the-protective-ai`) is the live
  reference system and proving ground — a real, customized instance.
  The master is extracted *from* Mattie's lessons, but Mattie is never
  the template.
- It contains **no** client-specific data, personas, or configuration.

## How companions are made

A new companion is a **copy** of this repo, not a rebuild:

1. Copy / fork this repository into a new instance repo.
2. Configure the instance (identity, tone, environment).
3. Provision the instance database.
4. Run Setup Mode to create the companion and its supported person.
5. Deploy the instance.

See `docs/setup/instance-copy-workflow.md`.

## What must never enter this repo

Real client data, any real supported-person data (e.g. Sandy's), live
memories, production secrets, one-off personas, and facility / family
information. See `docs/setup/template-boundaries.md`.

## The golden rule

> The master template changes **only** when we improve the platform for
> **all** future companions. Client-specific work never flows back into
> the master.

## Status

Scaffold only (GM-0). Application code, the governance system, the setup
wizard, admin tooling, and deployment readiness are added by later
GM-series PRs.

---

Lylo — Love Your Loved One.
