---
type: script-doc
id: SCRIPT-admissions-load
title: Invented admissions ETL
purpose: Loads the invented admissions extract and normalises the ward codes.
language: sql
file: 50 Scripts/admissions-load.sql
file_hash: sha256:1d9b0c6f5a4e3721c8b2d0f6e4a917c53b8d2e6f0a1c4b7d9e2f5a8c1b4d7e0a
inputs:
  - dataset: SCDB-invented-admissions
    version: 2026-Q3
    changed: 2026-07-15
  - dataset: SCDB-invented-wards
    version: 2024-final
    changed: 2024-01-08
outputs:
  - kind: table
    path: 94 Runs/invented-admissions.parquet
last_run: 2026-05-04
last_run_by: yh
---

# Invented admissions ETL

**Invented.** §7 C3's headline finding: *not re-run since its input dataset
changed*. The admissions extract moved to 2026-Q3 on 2026-07-15; this last ran
on 2026-05-04. Everything downstream of it is built on the older extract.

The second input is listed too, and does *not* raise a flag - it changed in
2024, long before the last run. A register that flagged both would be a register
nobody reads.
