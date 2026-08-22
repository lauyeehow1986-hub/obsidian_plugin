---
type: scdb-view
id: VIEW-stuck
title: Stuck with someone
description: Open requests waiting on a person, worst first, grouped by who.
hat: hod
query:
  types:
    - scdb-request
  where:
    all:
      - { field: blocked_on, op: not-empty }
      - { field: completed, op: is-false }
      - any:
          - { field: sla_state, op: is, value: breached }
          - { field: dwell, op: gt, value: 2w }
  sort:
    - { field: dwell, direction: desc }
  group: { field: blocked_on, direction: asc }
  aggregates:
    - { fn: count }
    - { fn: median, field: dwell, label: Typical wait }
  columns: [id, title, stage_label, dwell, age, bounces]
---

Everything sitting with a named person that has either breached its stage target
or been there more than a fortnight. Grouped by person, so one chase-up covers
the lot.

This is a plain markdown note. Edit the query above by hand or from the Explore
board — both write the same frontmatter.
