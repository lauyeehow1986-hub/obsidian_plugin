---
type: redcap-form
id: FORM-invented-followup
title: Invented 30-day follow-up
study: "[[Invented Cohort Study]]"
status: approved
version: "1"
updated: 2026-08-20
---

# Invented 30-day follow-up

**Invented, and deliberately clean.** No identifiers, every choice list
well-formed, branching logic that names a field this form actually declares.

It is the fixture that proves the register can say *ready* — a board that only
ever shows problems teaches you to ignore it.

```yaml redcap
instruments:
  - name: followup30
    label: 30-day follow-up
    fields:
      - name: fu_record_id
        type: text
        label: Record ID
      - name: fu_done
        type: yesno
        label: Was the invented follow-up completed?
      - name: fu_symptoms
        type: checkbox
        label: Invented symptoms at follow-up
        choices: 1, Symptom A | 2, Symptom B | 3, Symptom C
        branching: "[fu_done] = '1'"
      - name: fu_symptom_other
        type: text
        label: Other invented symptom
        branching: "[fu_symptoms(3)] = '1'"
      - name: fu_class
        type: radio
        label: Invented severity class at follow-up
        choices: 1, I | 2, II | 3, III | 4, IV
        variable: VAR-CLASS
```
