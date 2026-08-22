---
type: scdb-view
id: VIEW-turnaround
title: Turnaround by month
description: Completed requests grouped by the month they arrived.
query:
  types: [scdb-request]
  where:
    all:
      - { field: completed, op: is-true }
  group: { field: received, direction: asc, bucket: month }
  aggregates:
    - { fn: count }
    - { fn: median, field: turnaround, label: Median turnaround }
    - { fn: max, field: turnaround, label: Worst }
  columns: [id, title, received, turnaround, bounces]
---

Median turnaround per month, with the worst case beside it. The median is the
number to quote; the worst case is the one you will be asked about.
