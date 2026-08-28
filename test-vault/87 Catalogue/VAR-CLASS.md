---
type: variable
id: VAR-CLASS
label: Invented severity class
domain: clinical
data_type: categorical
coding:
  - code: "1"
    label: Invented class I
  - code: "2"
    label: Invented class II
  - code: "3"
    label: Invented class III
  - code: "4"
    label: Invented class IV
definition: Invented four-level severity scale, assigned by the treating team.
collected_in:
  - "[[Invented Cohort Study]]"
identifier: false
version: 1
changed: 2024-01-15
---

# Invented severity class

**Invented.** A categorical variable, so the board has something whose meaning
lives in the coding rather than in a range. A code with no coding list is a
number nobody can interpret two years later, which is why the parser complains
when a categorical variable has none.
