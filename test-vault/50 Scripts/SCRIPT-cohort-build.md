---
type: script-doc
id: SCRIPT-cohort-build
title: Invented cohort build
language: r
study: "[[Invented Cohort Study]]"
variables:
  - "[[VAR-EJECTION@2]]"
  - "[[VAR-CLASS]]"
  - "[[VAR-NOT-CATALOGUED]]"
last_run: 2026-05-12
---

# Invented cohort build

**Invented.** A script documentation note (§5.14) that exists now, before C3
builds anything around it, because it is the far end of the catalogue join: the
person who writes a script is the one who knows which variables it read, and
requiring them to edit three catalogue notes to say so is how a dependency map
ends up empty.

Its three citations are each a different case on the catalogue board:

- `VAR-EJECTION@2` — **stale**: the catalogue is at version 3.
- `VAR-CLASS` — **unversioned**: which definition it meant is not recorded.
- `VAR-NOT-CATALOGUED` — **orphan**: nothing by that name is in the catalogue,
  so either it is a typo or something is being consumed that was never
  catalogued.
