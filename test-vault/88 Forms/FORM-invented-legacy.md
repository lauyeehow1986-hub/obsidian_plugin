---
type: redcap-form
id: FORM-invented-legacy
title: Invented legacy instrument
study: "[[Invented Unstated Study]]"
status: draft
updated: 2026-08-20
---

# Invented legacy instrument

**Invented, and deliberately broken** — one instance of each validation rule
that matters, so every refusal has a fixture and not only a unit test:

- `Legacy Field` is not a name REDCap accepts.
- `redcap_event_name` is a name REDCap reserves for itself.
- `sev` uses the code `1` twice.
- `bmi` is a calculated field with nothing to calculate.
- `late_visit` sets a minimum above its maximum, so nothing can be entered.
- `sx_detail` tests `[sx(9)]`, and `sx` offers no choice coded 9 — logic like
  that uploads happily and then never fires, which is the failure that costs a
  study a variable rather than an afternoon.

It also carries an identifier against a study that records **no approved
scope**, so it demonstrates the *uncheckable* case: not a pass, not a block, a
question that has to be answered somewhere other than this file.

```yaml redcap
instruments:
  - name: legacy
    label: Legacy instrument
    fields:
      - name: legacy_id
        type: text
        label: Record ID
      - name: Legacy Field
        type: text
        label: An invented field with a name REDCap will not take
      - name: redcap_event_name
        type: text
        label: An invented field using a reserved name
      - name: legacy_nric
        type: text
        label: Invented national identity number
        identifier: true
        justification: Carried over from the invented paper form.
      - name: sev
        type: radio
        label: Invented severity
        choices: 1, Mild | 1, Moderate | 3, Severe
      - name: bmi
        type: calc
        label: Invented derived index
      - name: late_visit
        type: text
        label: Invented visit date
        validation: date_ymd
        min: "2026-12-31"
        max: "2026-01-01"
      - name: sx
        type: checkbox
        label: Invented symptoms
        choices: 1, Symptom A | 2, Symptom B
      - name: sx_detail
        type: text
        label: Invented symptom detail
        branching: "[sx(9)] = '1'"
```
