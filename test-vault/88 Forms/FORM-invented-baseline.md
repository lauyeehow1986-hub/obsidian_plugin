---
type: redcap-form
id: FORM-invented-baseline
title: Invented baseline visit
study: "[[Invented Cohort Study]]"
project: Invented cohort (invented REDCap project)
status: review
version: "2"
updated: 2026-08-20
---

# Invented baseline visit

**Invented.** The form `VAR-EJECTION` names in its `source_form`, so the
catalogue join has a far end.

Two governance findings fire here on purpose, and neither of them blocks:

- `case_ref` cites `[[VAR-CASE-REF]]`, which the catalogue flags as an
  identifier and which records **no justification**. The form does not add one
  either, so nothing in the vault says why it is held.
- `pt_initials` is **not** flagged, and its name looks like a person's name.
  That finding is a guess from the name and says so — it exists because an
  identifier nobody flagged is invisible to every other check here, REDCap's
  included.

```yaml redcap
instruments:
  - name: baseline
    label: Baseline visit
    fields:
      - name: record_id
        type: text
        label: Record ID
      - name: case_ref
        type: text
        label: Invented case reference
        identifier: true
        variable: VAR-CASE-REF
      - name: pt_initials
        type: text
        label: Patient name (initials only)
      - name: index_date
        type: text
        label: Invented index date
        validation: date_ymd
        min: "2019-01-01"
        variable: VAR-INDEX-DATE
      - name: nyha
        type: radio
        label: Invented severity class
        choices: 1, I | 2, II | 3, III | 4, IV
        required: true
        variable: VAR-CLASS
      - name: ef
        type: text
        label: Invented ejection measure
        validation: number
        min: "0"
        max: "100"
        variable: VAR-EJECTION
      - name: ef_comment
        type: notes
        label: Why the measure is outside the usual range
        branching: "[ef] < '30'"
```
