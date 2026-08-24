---
type: policy
id: SOP-SCDB-01
title: SCDB standard operating procedure — preparing an extract
authority: "[[Invented SCDB]]"
scope: scdb
status: current
version: "2"
effective: 2025-10-01
review_due: 2027-01-31
derives_from:
  - { ref: "[[POL-DATA-REL-02]]", clause: "5.1",
      note: "Who may run an extract without further authorisation." }
  - { ref: "[[POL-DATA-REL-02]]", clause: "5.4",
      note: "The destruction confirmation this SOP tells the coordinator to chase." }
governs:
  - { what: script, ref: "[[SCRIPT-extract-cohort]]", clause: "3" }
---

# 1 Purpose

Invented SOP. It exists in this vault to demonstrate a dependency declared from
the *far* end: nothing in `POL-DATA-REL-02` lists this note, and it still
appears on that policy's impact map because this note says which clauses of it
the procedure rests on.

# 2 Before starting

Confirm the request is at the extraction stage and that the governance fields
on the request note are complete.

# 3 Preparing the extract

Run the documented extraction script against the approved variable list. Record
the run against the request so the output can be traced back to the code that
produced it.

# 4 After release

Diary the destruction confirmation. Chase it if it has not arrived by the end of
the approved study period.
