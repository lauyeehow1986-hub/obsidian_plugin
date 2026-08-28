---
type: variable
id: VAR-INDEX-DATE
label: Invented index date
domain: administrative
data_type: date
definition: Date of the invented index episode.
collected_in:
  - "[[Invented Cohort Study]]"
identifier: false
version: 2
supersedes: VAR-INDEX-DATE@1
changed: 2025-06-01
change_reason: Switched from admission date to the invented episode start.
---

# Invented index date

**Invented.** At version 2 with an **empty `history`** — the version number
survives, what it used to mean does not.

That is the finding the board reports, and it is a real failure mode rather than
a contrived one: bumping a version by hand in the frontmatter is the obvious
thing to do and it silently discards the previous definition. Revising through
the catalogue board keeps it.
