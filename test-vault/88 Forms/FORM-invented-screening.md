---
type: redcap-form
id: FORM-invented-screening
title: Invented screening log
study: "[[Invented Registry Extract]]"
status: draft
updated: 2026-08-20
---

# Invented screening log

**Invented.** The one fixture that is *blocked*, and the only kind of finding in
D2 that blocks anything.

`screen_mrn` is flagged as an identifier. `[[Invented Registry Extract]]` is
approved to collect **none**. Exporting the dictionary anyway is allowed — a
working tool has to let an instrument run ahead of its paperwork — but it takes
a typed reason, and the reason is written into the audit ledger as a
`gate-override` beside the `export` entry (§5.6).

Note that `screen_mrn` *is* justified on the field. That is not the problem: the
justification says why the facility wants it, and the study record says nobody
approved it. Those are different questions and only one of them is a gate.

```yaml redcap
instruments:
  - name: screening
    label: Screening log
    fields:
      - name: screen_id
        type: text
        label: Screening ID
      - name: screen_mrn
        type: text
        label: Invented hospital number
        identifier: true
        justification: Needed to reconcile the screening log against the invented admissions feed.
      - name: screen_eligible
        type: yesno
        label: Eligible for the invented cohort?
      - name: screen_reason
        type: notes
        label: Reason not eligible
        branching: "[screen_eligible] = '0'"
```
