---
type: script-doc
id: SCRIPT-frailty-index
title: Invented frailty index derivation
purpose: Derives the invented frailty index from comorbidity counts.
language: python
file: 50 Scripts/frailty-index.py
inputs:
  - dataset: SCDB-invented-comorbidity
    version: 2026-Q2
    changed: 2026-06-20
---

# Invented frailty index derivation

**Invented.** Documented and never run - which the board reports as its own
finding rather than folding into "fine". Nothing records this producing
anything, so there is no point in time to compare its input against, and calling
it current would be the lie.

It also carries no `file_hash`, so it feeds the count the board leads with:
scripts where nothing can ever say which version of the code produced an output.
