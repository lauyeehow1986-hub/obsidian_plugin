---
type: script-doc
id: SCRIPT-echo-qc
title: Invented echo QC checks
purpose: Range and completeness checks over the invented echo extract before release.
language: r
file: D:\invented-analysis\echo-qc.R
file_hash: sha256:1d9b0c6f5a4e3721c8b2d0f6e4a917c53b8d2e6f0a1c4b7d9e2f5a8c1b4d7e0a
study: "[[Invented Cohort Study]]"
inputs:
  - dataset: SCDB-invented-echo
    version: 2026-Q1
    changed: 2026-03-02
outputs:
  - kind: report
    path: 95 Exports/invented-echo-qc.html
last_run: 2026-04-01
last_run_by: yh
---

# Invented echo QC checks

**Invented.** The `current` case, and the one that shows what "current" is
allowed to mean: every input predates the last recorded run, the run completed,
and its hash matches what this note documents.

`file` points at a path outside the vault, so *Check hash* declines to read it
rather than reaching for it - rule 8's boundary, stated out loud instead of
quietly crossed. The digest here is therefore a recorded claim, and the run
record is what corroborates it.
