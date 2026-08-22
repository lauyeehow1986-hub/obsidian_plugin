# Changelog

All notable changes to SCDB Cockpit. Governance-gate changes get their own
clearly marked entry (CLAUDE.md §10).

## Unreleased

Phase A1: request tracking. The domain layer — pure, Obsidian-free, unit-tested.

### Added
- Workflow spec loader (§5.2): validates stages, transitions, gates and the
  `retired:` mapping, reporting problems rather than throwing.
- Transition engine with structural refusals (unknown stage, wrong workflow
  version, leaving a terminal stage) and gate refusals, each with a
  plain-English reason. Structural refusals are not overridable.
- Dwell maths (§5.1): current dwell, cumulative age, turnaround, per-stage
  roll-up, bounce and revisit counts, SLA state, and median dwell per stage.
  All computed from `history`, never stored.
- Request intake: ULID `uid`, `REQ-YYYY-NNN` label allocation with an owner
  segment for a future second allocator.
- Holdup views: by stage, by blocking party, and aged/breaching.
- Audit ledger (§5.6): append-only rows, SHA-256 hash chain seeded across month
  boundaries, chain verification that names the first row not to reconcile, and
  correction entries.
- Pure-TypeScript SHA-256, verified against the NIST vectors, so chain values
  are identical on every surface the plugin runs on.
- One timestamp parser and one duration formatter for the whole plugin.
- 176 further tests; 207 in total.

### Added — the vault and UI half
- Workflow store reading `_config/workflows/*.yaml` through Obsidian's core
  `parseYaml`, reloading when a spec file changes.
- In-memory request index built from the metadata cache and updated
  incrementally on change, rename and delete.
- Audit ledger writer: monthly files in `82 Audit/`, appends serialised through
  a queue, chain seeded from the previous month, and
  `SCDB: Verify audit ledger` reporting the first row that does not reconcile.
- Cockpit view with four boards — Queue (by stage), Holdup (by blocking
  person), Ageing, and Health (median dwell per stage, spec problems, notes
  that need attention).
- Request detail dialog: dwell, age, bounce count, time per stage, evidence
  with verbal records marked, and the full history.
- Stage-change dialog showing every gate live, with the override reason field
  appearing only when an override is possible and required before the button
  enables.
- Intake dialog and `SCDB: New request`; also `SCDB: Move this request to
  another stage` and `SCDB: Rebuild the request index`.
- Semantic status palette in `styles.css`, resolved through Obsidian's theme
  variables. Status is always a glyph and a word as well as a colour.
- Six synthetic request fixtures in the test vault covering a fresh request, an
  evidenced identifiable extraction, a bounced request, a completed one and a
  lapsed-approval case.
- The smoke test now runs `onload` against a stub App, so wiring errors are
  caught before a build travels.

### Added — the migration view
- **Migration board** (§5.2), completing A1. Any request whose
  `workflow_version` is behind its spec, or whose stage the spec no longer
  lists, is quarantined from stage actions and listed here: old stage →
  proposed new stage, every proposal editable, applied in bulk, nothing written
  until Apply. `SCDB: Migrate requests to the current workflow version` opens
  the cockpit on it, and a stranded request carries a "migrate" chip on every
  board so it is visible where the work happens.
- A migration entry is written to `history` marked `migration: true`, and
  `schema-migration` to the audit ledger naming both versions and the mapping.
- Two further synthetic fixtures: one stranded by a stage rename, one sitting
  in a stage the spec dropped without a mapping. The test-vault spec is now v2
  with a `retired:` entry, so the board has something real to show.
- 24 further tests; 231 in total.

### Added — phase A2, the index and query engine
- **Note index.** Every note declaring a `type:` is indexed from Obsidian's
  metadata cache and updated incrementally. `RequestIndex` became a projection
  over it, so there is one read of the cache and one definition of scope rather
  than two that can drift.
- **Query model** (`domain/query/`): an OR/NOT filter tree, multi-key sort,
  grouping with date buckets, and aggregates (count, distinct, sum, mean, min,
  max, median, p90). Plain data throughout, so it round-trips through YAML.
- **Computed fields are first-class.** `domain/request/queryFields.ts` exposes
  dwell, age, turnaround, bounce count, SLA state, days-to-due and
  awaiting-migration as ordinary fields. Filtering, sorting, grouping and
  aggregating work on them without the engine knowing what a request is. This is
  the half core Bases structurally cannot do, and the reason we own an engine.
- **Field inference for every other type.** Types without a declared catalogue
  get one from the frontmatter actually present, so a note type added to the
  vault contract is queryable before any code knows about it.
- **Saved views** as `type: scdb-view` notes in `90 Dashboards/`, written with
  `all:` / `any:` / `not:` so a person can edit one by hand. Loading, saving and
  a validation pass that names an unknown field instead of failing silently.
- **Explore board** in the cockpit: type picker, two-level filter builder,
  column/sort/group controls, aggregates, and a grouped table with per-group and
  overall totals.
- **Export to CSV and markdown**, into `95 Exports/`, after a confirmation
  naming the file and row count, with an `export` entry appended to the audit
  ledger (§5.6). CSV is RFC 4180 with CRLF and carries a machine-readable
  duration column beside the human one.
- `npm run bench` measures the A2 acceptance criterion. On this machine a
  5,000-note vault re-indexes in **23 ms** against a 1,000 ms budget; building
  every row and running a filtered, grouped, aggregated query adds 28 ms. At
  50,000 notes the re-index is 191 ms.
- 62 further tests; 293 in total.

### Decided — A2
- **Comparison is kind-directed**, taken from the field catalogue rather than
  guessed from the runtime type of the value. An `sla_days` of `"21"` written as
  a string would otherwise sort between 2 and 3.
- **Missing is never zero.** A request with no `due` is not overdue, a stage with
  no target is not on track, and neither contributes to a mean. Nulls are
  excluded from aggregates and sorted last in both directions.
- **Dates and durations in a saved view stay as written** — `today`, `-14d`,
  `2w` — and resolve at evaluation, so a view means the same thing next month
  and the note is readable.
- **Results are never cached.** Dwell depends on the current time, so a cached
  result is one that is quietly wrong by tomorrow. The benchmark is what makes
  recomputing on every repaint defensible.

### Fixed
- **Cards, tabs and inline links were being styled as form controls.** Obsidian's
  `app.css` gives every `<button>` a fixed `height: var(--input-height)` (30px)
  plus `white-space: nowrap` and centred content. Several elements here are
  buttons for keyboard and screen-reader reasons rather than because they are
  controls, and they never opted out — so a three-line request card was crushed
  into a 30px box with its text overflowing onto the rows above and below it,
  and long titles pushed past their column. Verified against the real
  stylesheet, at full width and at a 320px sidebar.
- The migration board's stage dropdown truncated its longest option; the column
  now reserves enough width to read it without opening the list.
- At sidebar width a stacked result row carried its columns' values with no
  headings — three unexplained durations. Each cell now prefixes its own label
  in that layout only.
- **The button reset is now the default rather than a list of exceptions.** The
  first fix named the four classes that needed to opt out, which left every
  future view one forgotten class away from the same collapse. Every button the
  plugin renders now gets the safe metrics, and the handful that genuinely are
  controls opt back in via `.mod-cta`, `.mod-warning` or `.scdb-control`. The
  failure modes are no longer symmetric: forgetting to mark a control costs a
  few pixels of height, where forgetting to exempt a card cost a legible view.
  `npm run smoke` fails a button in `src/ui` that declares neither.

### Changed
- `minAppVersion` raised to 1.6.0: `Vault.process` is used for append-only
  writes and arrived in that release. Keeping it honest matters more than
  claiming reach we do not have.
- The placeholder DUA gate now reads `governance.dua_signed == true` rather
  than the raw status field, so it actually requires an evidence record.
- The placeholder delivery gate now also requires `delivery_method`.

### Governance rules implemented
- **A gate override requires a typed reason.** Refusing to give one cancels the
  override — enforced in the engine, not only in the UI.
- **A `status: signed` does not satisfy a gate on its own.** It needs a
  non-verbal evidence record behind it (§5.5).
- **Verbal evidence never satisfies a hard gate**, and is surfaced as a warning
  wherever it appears.
- **A gate atom that cannot be evaluated refuses.** An unreadable or mistyped
  field never passes.
- **A request behind the workflow spec version is quarantined** from stage
  changes until it is migrated.
- **Migration never silently remaps.** The spec proposes a target only when the
  stage id is still live or `retired:` maps it. Any other target — including
  every choice for a stage the spec dropped — requires a typed reason, which is
  written to the ledger against each request in the batch.
- **Migration does not evaluate governance gates**, deliberately: a gate guards
  entry to a stage as a governance decision, while a migration relabels a stage
  the request is already in. Running gates would strand a request permanently
  whenever a gate was added after it arrived.
- **A note recording a spec version newer than the installed one is never
  rewritten.** It is listed, with the reason, and left alone.

### Notes
- **Verified end to end on Obsidian 1.12.7**, against a real vault: both
  stranded fixtures migrated, the ledger chain recomputed from genesis and
  reconciled, tampering with a written row was detected, and the migrated
  request kept its 26-day dwell rather than resetting to zero.
- `processFrontMatter` leaves bare dates alone — `received: 2026-07-20` does not
  come back as `2026-07-20T00:00:00.000Z`. It does re-serialise `history` from
  flow style to block style on first write; no data is lost and the note stays
  hand-readable, so this is accepted rather than worked around.
- A migration relabels the occupancy a request is already in rather than
  starting a new one, so renaming a stage does not reset a dwell clock, invent
  a segment in the median-dwell statistics, or register as a bounce.
- SLA targets are counted in **calendar days**. Whether the institutional eData
  SLAs are working days is an open question (CLAUDE.md §11); `daysBetween` is
  the single place to change it.

## [0.1.0] — 2026-07-31

Phase A0: scaffold. No user-facing capability yet.

### Added
- Build toolchain: TypeScript (strict), esbuild, Preact + htm with JSX.
- `npm run package` produces the three-file sneakernet release zip.
- Settings schema with versioning and a migration path, including refusal to
  overwrite settings written by a newer build.
- ULID generation for the immutable `uid` every note will carry.
- Synthetic test vault with a placeholder eData workflow spec.
- Vitest over `domain/`; 31 tests.
- `npm run smoke` loads the built bundle against a stubbed Obsidian module,
  catching load failures without opening Obsidian. Gates `npm run package`.

### Notes
- The eData workflow in `test-vault/_config/workflows/` is a **placeholder**.
  Real stage names, owners and gates replace it before any real use.
