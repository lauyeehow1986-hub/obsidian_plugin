---
type: variable
id: VAR-EJECTION
label: Invented ejection measure
domain: imaging
data_type: numeric
units: "%"
valid_range:
  - 0
  - 100
definition: Invented biplane method, per the invented departmental protocol v3.
collected_in:
  - "[[Invented Cohort Study]]"
source_form: "[[FORM-invented-baseline]]"
identifier: false
version: 3
supersedes: VAR-EJECTION@2
changed: 2026-02-01
change_reason: Aligned to the invented 2025 guideline.
history:
  - version: 1
    on: 2019-04-01
    definition: Invented visual estimate, recorded in bands.
    reason: First issue.
  - version: 2
    on: 2023-07-01
    definition: Invented biplane method.
    data_type: numeric
    units: "%"
    valid_range:
      - 0
      - 100
    identifier: false
    reason: Moved off visual estimation to a measured value.
---

# Invented ejection measure

**Invented.** The worked example for §5.8: three versions, each with a date and
a reason, so "which definition was in force when this extraction ran" has a real
answer rather than a shrug.

Two things this fixture exists to prove.

**Version 1 recorded only a definition.** Ask what the units were in 2020 and
the answer is *not recorded*, not `%`. Today's units are deliberately not
borrowed backwards — a confident wrong answer about what a 2020 extraction
measured is the failure the lineage code is built to avoid.

**The script that consumes it cites version 2.** The catalogue has moved to 3,
so that citation shows as stale on the board. That is the finding: whatever the
script says about this variable was written against a definition that has since
changed.
