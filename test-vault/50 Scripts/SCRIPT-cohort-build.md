---
type: script-doc
id: SCRIPT-cohort-build
title: Invented cohort build
purpose: Joins the invented echo and admissions extracts into the analysis cohort.
language: r
file: 50 Scripts/cohort-build.R
file_hash: sha256:6144e20da75f727c3b40f44e9300913a8ea8363817fc8325e08dbb1de77c2499
hash_checked: 2026-05-12
study: "[[Invented Cohort Study]]"
inputs:
  - dataset: SCDB-invented-echo
    version: 2026-Q1
    changed: 2026-03-02
  - dataset: SCDB-invented-admissions
    version: 2026-Q1
    changed: 2026-03-02
outputs:
  - kind: table
    path: 94 Runs/RUN-2026-05-12-0001-cohort.csv
variables:
  - "[[VAR-EJECTION@2]]"
  - "[[VAR-CLASS]]"
  - "[[VAR-NOT-CATALOGUED]]"
last_run: 2026-05-12
last_run_by: yh
---

# Invented cohort build

**Invented.** The script documentation note §5.14 describes, and the far end of
the catalogue join: whoever writes a script is the one who knows which variables
it read, and requiring them to edit three catalogue notes to say so is how a
dependency map ends up empty.

Its three variable citations are each a different case on the **catalogue**
board:

- `VAR-EJECTION@2` - **stale**: the catalogue is at version 3.
- `VAR-CLASS` - **unversioned**: which definition it meant is not recorded.
- `VAR-NOT-CATALOGUED` - **orphan**: nothing by that name is catalogued, so
  either it is a typo or something uncatalogued is being consumed.

On the **script** board it is `code-moved`, and the two halves of that are worth
separating. `cohort-build.R` beside this note still hashes to exactly what
`file_hash` claims, so *Check hash* reports a match. What moved is the run:
`RUN-2026-05-12-0001` recorded a different digest, meaning the code that
actually produced that table is not the code documented here. A hash on the note
proves the documentation is current; only the hash on the run proves what made
the numbers.
