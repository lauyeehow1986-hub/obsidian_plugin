---
type: script-doc
id: SCRIPT-lvef-trend
title: Invented ejection trend over time
purpose: Plots the invented ejection measure by year of admission.
language: r
file: 50 Scripts/lvef-trend.R
file_hash: sha256:1d9b0c6f5a4e3721c8b2d0f6e4a917c53b8d2e6f0a1c4b7d9e2f5a8c1b4d7e0a
study: "[[Invented Cohort Study]]"
inputs:
  - dataset: SCDB-invented-echo
    version: 2025-Q3
    changed: 2025-09-01
outputs:
  - kind: plot
    path: 95 Exports/invented-lvef-trend.png
variables:
  - "[[VAR-EJECTION]]"
last_run: 2025-11-20
last_run_by: yh
---

# Invented ejection trend over time

**Invented.** The C2 join, which is the thing §7 C3 asks for by name. This last
ran on 2025-11-20; `VAR-EJECTION` moved to version 3 on 2026-02-01. So the
figure in the deck was drawn under the *previous* definition of the measure it
plots, and nothing about the script, its inputs or its code says so.

Note what is deliberately not reported here. The citation names no version, so
the catalogue board has nothing to call stale - and yet the question "is this
figure still current" has a clear answer. Only a date can give it.
