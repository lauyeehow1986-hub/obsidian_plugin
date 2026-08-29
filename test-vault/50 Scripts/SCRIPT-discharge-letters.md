---
type: script-doc
id: SCRIPT-discharge-letters
title: Invented discharge letter counts
purpose: Counts invented discharge letters issued within seven days, by ward.
language: r
file: 50 Scripts/discharge-letters.R
file_hash: sha256:1d9b0c6f5a4e3721c8b2d0f6e4a917c53b8d2e6f0a1c4b7d9e2f5a8c1b4d7e0a
inputs:
  - dataset: SCDB-invented-admissions
    version: 2026-Q1
    changed: 2026-03-02
outputs:
  - kind: table
    path: 95 Exports/invented-discharge-letters.csv
last_run: 2026-06-11
last_run_by: yh
---

# Invented discharge letter counts

**Invented.** The most recent run ended `error`, so the outputs this note
promises may be missing or half-written. That outranks every other finding on
the board: an old number is a judgement call, and a number that was never
produced is not.
