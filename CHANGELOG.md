# Changelog

All notable changes to SCDB Cockpit. Governance-gate changes get their own
clearly marked entry (CLAUDE.md §10).

## Unreleased

### Added — B1, the daily rhythm pack

Five features that share the A2 query engine and, together, are what make the
plugin worth opening in the morning.

- **Quick capture** — `Ctrl+Shift+C`, one line, straight into `00 Inbox/` with
  the hat you are wearing recorded. It asks no second question: there is a test
  asserting the frontmatter has no field you could leave blank. The dialog
  closes before the write completes, and a failed write hands the typed line
  back in a notice rather than losing it.
- **Daily briefing** — a dated markdown note: what could not be read, what is
  due today, what is against target, what is stuck and with whom, what outreach
  is unanswered, which decisions are awaited, what is coming up. Markdown rather
  than a view, so a morning is still legible in six months and survives the
  plugin being uninstalled. It never overwrites one that already exists — the
  note is a record of a morning and may have been annotated by lunchtime.
  **Off by default** (rule 3 applied to the vault) and available on demand from
  the palette.
- **Meeting agenda** — pick a person, get everything they are holding up:
  requests awaiting them, manuscripts awaiting their review, obligations they
  own, and outreach they have not answered, urgent first with dwell attached.
  The value is the *join* — those four live in four folders under four
  differently-named fields, and one forgotten is another fortnight of dwell on
  a request nobody mentioned. It carries no judgement about whether the person
  is slow; a tool that generates accusations gets used once.
- **Chase-up composer** — the same agenda rendered into a draft and handed to
  Outlook or Teams. Clipboard is an equal option, not only a fallback. The draft
  is always shown and editable before anything opens.
- **Outreach ageing (email Tier 0)** — every composed message opens or updates a
  correspondence thread, so unanswered outreach ages into the **same** holdup
  board as blocked requests rather than a board of its own. One click marks a
  thread answered. No mailbox access of any kind: the plugin knows what it
  composed, which turns out to be enough.

### Rules and boundaries — B1

- **Nothing is ever sent.** The plugin composes a URI and hands it to the OS
  shell; you press send. Every message is recorded as `composed_only: true` and
  every ledger entry says `message-composed` — never `message-sent`, because we
  cannot know that and an audit trail claiming otherwise is worse than none
  (§5.11 rule 6). The briefing and the agenda say "no reply **recorded**" for
  the same reason.
- **Addresses containing a CR or LF are refused, not escaped** (§5.11 rule 3).
  `a@b.com<CRLF>bcc:attacker@example.com` would silently blind-copy a message
  about a clinical data request; encoding the body does not help, so an address
  we cannot vouch for is rejected and named. Commas, quotes, brackets, control
  characters and non-ASCII go the same way, and one bad address refuses the
  whole draft rather than quietly dropping a recipient.
- **The scheme allowlist is applied to the built string, one line above
  `openExternal`** (§5.11 rule 4). `mailto:`, `msteams:`, and `https:` only for
  one hardcoded host. A URL from note content never reaches the launcher.
- **No code path shortens a URI** (§5.11 rule 1). Over the configured ceiling
  the draft goes to the clipboard whole, with both numbers in the message. The
  ceiling defaults to 1,800 — deliberately under the ~2,000 where handlers start
  to cut — and §11's open question about the real figure now has a **"Test
  mailto:" and "Test Teams" button in settings** that answers it in ten seconds
  on the machine that matters.
- **§5.11 rule 5 is enforced by construction, not by filtering.** A message
  template can interpolate exactly six variables — `{{name}}`, `{{date}}`,
  `{{count}}`, `{{summary}}`, `{{items}}`, `{{actor}}` — and there is no
  `{{body}}` or `{{note}}` among them, so no template can reach note prose into
  a string that passes through the OS shell and into system logs.
- **Ledger entries count recipients rather than naming them.** A clinician's
  name in a governance ledger is exactly the indirectly identifying material
  §2 warns the vault may hold.
- **Marking a thread answered is deliberately not logged.** §5.6 lists what a
  consequential action is and a human replying to a human is none of them;
  logging every such click would bury the entries that matter.
- **A message body is never stored on a thread note** — a one-line summary
  goes in, because thread notes are read back into briefings and exports.
- **`75 Correspondence/` stays gitignored everywhere, with no exception.** The
  synthetic threads that document §5.10 were first committed behind a `!` rule
  narrowed to `test-vault/`; they now live in `75 Correspondence-fixtures/`
  instead, a folder name the ban never covered. Same files, same tests, but the
  rule protecting the highest-risk folder in a real vault is once again
  unconditional — an exception is a rule you have to remember, and the moment
  it matters is the moment you are tired. Three tests hold the line: the ban is
  present, no line in `.gitignore` starts with `!`, and no fixture sits in a
  path segment called `75 Correspondence`. The plugin still *writes* new threads
  to the real folder, so anything generated while developing stays out of git by
  itself.
- **The fixture guards now describe the *committed* vault, not the folder.**
  Driving the chase-up composer in the test vault — the write path the rename
  actually touched — created `75 Correspondence/THR-2026-0003.md` exactly as
  designed, left `git status` clean, and turned `npm test` red: the guards
  walked the filesystem, so the plugin's own gitignored output counted as a
  fixture. Two tests failed, including the new one, which accused the run of
  committing correspondence it had not committed. The fixture set is now what
  `git ls-files` tracks, so generated notes are ignored by the suite the same
  way git ignores them, and the correspondence guard asks the question it meant
  to ask: no *committed* fixture may sit where the ban would hide it. The
  content safety net moved the other way and now scans **every file on disk,
  tracked or not**, for an address outside RFC 2606's reserved domains — an
  ignored file is exactly where a real address would go unnoticed. All three
  were re-checked by violating them.

### Vault contract — B1

- New folder `90 Dashboards/Briefings/` (configurable). §5 names no home for a
  briefing; it sits under Dashboards rather than beside them because a briefing
  is a dated record of one morning, not a saved view, and a year of them would
  swamp the folder the saved views live in.
- New note types in use: `correspondence` (§5.10) and `capture` (§5.14).
- `authors` on a publication is now parsed (§5.4), which is what lets the agenda
  find manuscripts awaiting somebody's review.
- Message templates live in `_config/messages/chase-up.md`, so tone and
  signature are yours (§5.11 rule 7). A missing one falls back silently.
- Settings schema **v4** with a migration: adds the message and briefing blocks,
  clamping numbers rather than resetting them, and keeps `lastDate` verbatim so
  repairing settings cannot regenerate today's briefing over yesterday's.

### Changed — B1

- The **holdup board** now shows unanswered outreach alongside blocked requests,
  grouped by the same person, with a "Chase up" button on each group. Same
  board, deliberately: "Dr Tan owes me a signature and has not replied to the
  email asking for it" is one situation, and splitting it across two screens is
  how the second half gets forgotten.
- Diagnostics no longer reports protocol handlers as "not built yet". It now
  probes whether Electron's shell is reachable at all — without opening
  anything, because a self-test that opens a mail window every run is a
  self-test people stop running — and points at the settings buttons for the
  part only the machine can answer.
- The overview's look-ahead window is now the configured briefing horizon rather
  than a hardcoded 60 days.

### Fixed — B1, found by running it

Four things the tests could not have caught and one they should have. All found
by driving the plugin in Obsidian 1.12.7 against the test vault.

- **The agenda dialog clipped its own buttons off the bottom of the window.**
  Not cramped — unusable: "Open in email" is the thing the dialog exists to
  reach, and at ordinary window heights it could not be reached or scrolled to.
  The body now scrolls, the item list and the message box are capped, and the
  action row is sticky.
- **The holdup board listed one person twice** — once for their blocked
  requests, once for their unanswered outreach, as two adjacent headings with
  the same name. That is precisely the failure that putting outreach on this
  board was meant to prevent: a reader finds the first heading, acts on it, and
  never sees the second. They now merge into one row per person
  (`domain/comms/holdup`, so "is this the same person" and "who is worst" are
  tested rather than laid out).
- **Two duration formatters disagreed in the same sentence.** The board said a
  request had been blocked "51 days" while the agenda called it "52 days", and
  the briefing said "56 days old" where the board said "55" — a local
  `Math.round` against `formatDuration`'s floor. §6 asks for one formatter;
  there is now one, with a test pinning the agenda's output to it.
- **A chase-up covering two requests only recorded one on the thread.** The
  second request's outreach would then have aged invisibly, because
  `threadsForRequest` could not find the conversation from it. `appendOutbound`
  now widens the request list, keeping existing entries' exact spelling and
  writing nothing when there is nothing new.
- The daily briefing is now gitignored under `test-vault/`: it is generated
  output like the `.base` dashboards, and committing one means every morning's
  test run dirties the tree.

### Answered — an open question from §11

**Outlook is registered as the `mailto:` handler on the dev machine**, and the
"Test mailto:" button opens the new Outlook (`olk`) with the subject we set.
Verified by pressing it. The Teams deep link and the real truncation ceiling are
still unmeasured, and still need checking on the *work* laptop rather than this
one — the button is there to make that a ten-second job.

### Added — A4, encrypted backup, restore and verification
- **Encrypted vault snapshots.** One AES-256-GCM file per snapshot, key derived
  with scrypt (N=32768, r=8), gzip inside the encryption, written to a folder
  the user configures outside the vault. No new dependency: Node's built-in
  `crypto` and `zlib` are already in Electron and marked external, so the
  container format is ~60 lines of our own rather than an 8 KB zip writer. The
  usual "any tool can open a zip" argument does not apply to a file that is
  sealed anyway.
- The archive header is **plaintext but authenticated** as GCM additional data,
  so `Verify` can report the date, file count and plugin version before asking
  for a passphrase, while editing it still fails the tag. Nothing identifying
  the vault — no paths, no note names, not the vault's own name — is outside
  the encryption.
- **The passphrase is never stored**, in settings or anywhere else, and the
  dialog says in plain words that losing it loses the archive.
- **Verify a backup snapshot**: decrypts, authenticates, and re-hashes every
  file against the manifest recorded when it was written. Writes nothing.
- **Restore from a backup snapshot**: creates missing files only, never
  overwrites, and refuses any path in the archive that escapes the vault — a
  snapshot travels, so by the time it is read it is untrusted input.
- **Retention** keeps the newest N. Only files matching the exact name this
  plugin generates can ever be deleted; everything else in the folder is counted
  and reported as untouched, which matters when the destination is Downloads.
  The confirmation names every snapshot that will be deleted, before writing.
- Status-bar nag once a destination is set and the last snapshot is older than
  the configured interval. Never having taken one counts as stale.
- Settings schema **v3** with a migration: adds the backup block, repaired field
  by field so a destination typed once is never lost to a bad number elsewhere.

### Added — A4, diagnostics and reference integrity
- **Run diagnostics self-test**: one command, one page of markdown, built to be
  pasted into a message. The production laptop has no dev tools, so this is the
  difference between a bug that can be described and one that cannot.
- Everything in it is **probed, not asserted**. The index is actually rebuilt
  and timed, the ledger chain actually walked, and core Mermaid actually asked
  to render a flowchart — because "we call a documented API" is not evidence
  that the API works on the Obsidian in front of you. The clipboard image API
  is checked for existence but deliberately *not* exercised: a self-test has no
  business destroying what you had copied.
- A check that cannot be run reports `n/a` and says why, never `ok`. Protocol
  handlers (B1) and interpreters (F1) are named as not-built-yet rather than
  quietly omitted, each pointing at the open question in §11 it depends on.
- The report warns, in its own header, that it names notes and folder paths —
  it carries no note content (rule 7), but it is still a file that travels.
- **Check link and reference integrity**: reconciles the two naming systems §5.2
  deliberately keeps apart. Reports notes sharing a `uid`, requests with none,
  references to a `uid` nothing carries, notes sharing an `id`, audit entries
  naming notes that are gone, and frontmatter wikilinks that resolve to nothing.
- **One repair, and only ever additive**: creating a note that something already
  links to, in the folder the linking field implies, with every path named
  before the button is pressed. Which of two notes claiming one `uid` is the
  impostor is not a question code can answer, so those are reported with the
  remedy in words instead. Nothing is ever deleted or rewritten.
- Findings are one per missing note rather than one per link to it — a request
  naming the same person in `requester`, `blocked_on`, an evidence record and
  two history entries is one gap, not five.

### Fixed
- **Settings are no longer overwritten by an empty read.** `loadData()`
  returning nothing is ambiguous — a first install and a failed read look
  identical — and the old code wrote defaults over it, which would silently
  destroy a configured backup destination and actor. Nothing is persisted until
  the first real change; defaults are what the next load produces anyway. Found
  when a hand-written `data.json` in a fresh vault came back as defaults.
- **A settings file that cannot be read now says so.** Declining to overwrite it
  was only half the fix: `loadData()` returns null for a `data.json` it could
  not parse exactly as for one that is absent, so the plugin ran on defaults in
  silence. The symptoms — a wrong actor in the ledger, a backup destination that
  looks like it was never set — read as "I must have forgotten to configure it",
  not as a fault, and on the work laptop there is no console to say otherwise.
  A present-but-unreadable file now raises a notice naming the file and stating
  that nothing was overwritten, and appears in diagnostics as a problem. Where
  we cannot check whether a file is there, it is reported as a first install
  rather than as an alarm we cannot substantiate.
- **Workflow spec advisories are no longer reported as problems.** The spec
  loader already grades what it finds — an `error` means the spec was refused
  and nothing it governs can change stage, a `warning` means it loaded and
  something is worth a look — and diagnostics flattened both to PROBLEM. That
  put a placeholder stage with no SLA target on the same footing as an unusable
  workflow. A report that cries wolf stops being read, and then the real
  problem goes unread with it.

### Rules and boundaries
- `services/backup.ts` is **the only module that touches `fs` or writes outside
  the vault**, and it is documented as the deliberate, confined exception to
  rule 8 that A4 requires. Vault reads and restore writes still go through
  Obsidian's APIs.
- A snapshot is logged to the audit ledger as an `export` (§5.6) — which is
  exactly what it is — rather than inventing a ledger action the vault contract
  does not define.
- `.obsidian/` is deliberately **not** in a snapshot: configuration is
  reproducible from a plugin zip, the notes are not.

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

### Added — phase A2b, Bases integration
- **Core Bases is layered on where it is present, and never depended on.**
  Obsidian 1.10+ ships Bases; our `minAppVersion` is deliberately lower, so every
  part of this is behind a runtime probe and its absence costs nothing.
- **`Create Bases dashboards`** writes four browsable `.base` files into
  `90 Dashboards/` — request queue, publications, correspondence, catalogue —
  giving native, editable, mobile-friendly tables without a line of grid code in
  our bundle. A confirmation names every file and how many notes it currently
  matches, so an empty table is never a surprise. **Existing files are never
  overwritten**: they are ordinary notes the user may have reordered or extended,
  and regenerating over the top would discard that (rule 8).
- **Two SCDB boards registered as first-class Bases view types** — `SCDB holdup`
  and `SCDB ageing`. Bases owns the query and the toolbar; we own the arithmetic
  it structurally cannot do — dwell from `history`, who is blocking, SLA state,
  bounce counts. They render the *same* components as the cockpit's own boards,
  deliberately: two implementations of "how long has this been stuck" that could
  disagree is the drift this plugin exists to prevent.
- `RequestIndex.viewsForPaths` turns a Bases result into the same `RequestView`
  the cockpit boards already take, so both surfaces compute dwell identically.
- 20 tests and 7 smoke checks; 331 tests in total. Bundle 124.0 KB.

### Decided — A2b
- **The `.base` schema was read off the shipped app, not guessed.** The view type
  id `table` is what Bases inserts when a file declares no views; `groupBy` is
  rejected outright unless it carries both `property` and `direction`; direction
  is `ASC`/`DESC`; property ids are prefixed `note.` / `file.` / `formula.` in
  `filters` and `properties` but written bare inside a view; and
  filter values must be quoted or they parse as identifiers. The writer also
  assigns its object to Obsidian's own `BasesConfigFile` interface, so a schema
  change breaks the build instead of filling the vault with unparseable files.
- **Generating dashboards is a command, not something that happens on load.**
  These are writes into the user's vault, and the principle behind rule 12 —
  nothing happens by surprise — applies to writes as much as to code.
- **No ledger entry for creating dashboards.** It is not in the §5.6 list, nothing
  is destroyed and nothing leaves the vault. An audit trail padded with routine
  events is one nobody reads (§5.12).

### Fixed
- **A plugin-wide load failure on any Obsidian older than 1.10.** `class X extends
  BasesView` is evaluated when the module loads, not when the class is used, so
  on a build where `BasesView` does not exist it threw `Class extends value
  undefined` — taking down the *entire* plugin, not just the Bases part. The
  class definitions are now deferred into a function called only after the API is
  confirmed. Caught by `npm run smoke`, which loads the bundle against an
  Obsidian stub with no Bases; a second stub that *has* Bases proves both view
  types still register.
- **Generated `.base` files churned the moment Bases touched them.** We wrote
  `order` and `groupBy.property` as `note.stage`; Bases accepts that, then
  rewrites it to bare `stage` — and reorders `groupBy` ahead of `order` — the
  first time the view is edited. Every user who opened a dashboard would have
  found an unexplained change in their vault. We now emit exactly the form Bases
  writes back, verified by generating a file, editing the view in the UI and
  diffing: no change.
- **The confirmation modal collapsed its file list into a run-on paragraph.**
  `ConfirmModal` put the whole message in one `<p>`, so the `\n` between entries
  did nothing. A dialog whose entire purpose is "here is exactly what will be
  written" has to be legible; `• ` lines now render as a real list, still built
  with `createEl` so nothing goes near `innerHTML` (§8).

### Verified — A2b in a running Obsidian
Driven through the real app (Obsidian **1.12.7**, test vault) rather than left
as an untested claim:
- Both view types appear in the Bases layout picker with their icons, alongside
  Table / Cards / List, and both render — holdup grouped by blocking party,
  ageing with its working "show on-track too" toggle.
- The generated `Request queue.base` opens as a native Bases table, grouped by
  stage, with our `displayName` labels applied and wikilinks live.
- Bases round-trips our custom view id: it serialises back as
  `type: scdb-holdup`.
- Re-running the command with the files present writes nothing and says so.
- **Developer console clean** — no errors or warnings across plugin load,
  dashboard creation and both boards rendering.

### Added — stage labels in the browse layer
The native table groups on the raw frontmatter value, so the queue's headings
read `awaiting-approval` rather than `Awaiting approval`. Stage labels live in
the workflow spec, which Bases cannot reach — so they are compiled into the
generated file as a Bases **formula**:

- `stage_label` is a nested `if()` chain built from the spec, and the queue
  groups on `formula.stage_label`. Headings now read *Awaiting approval*,
  *SCDB triage*, *QC*.
- **Unknown ids fall through to the raw `note.stage`, deliberately.** A request
  sitting in a stage the spec has dropped keeps showing its raw id, so a
  stranded note stays visibly odd in the browse layer exactly as it carries a
  "migrate" chip on our own boards (§5.2).
- Ids and labels are escaped before they are embedded. They come from a YAML
  file the user edits, and an unescaped quote would produce an expression Bases
  cannot parse — and an unparseable `.base` does not degrade, it fails to open.
- **The copy can go stale, so drift is reported rather than hidden.** We never
  overwrite an existing file, so renaming a stage would otherwise leave the old
  label showing indefinitely. `plan()` now compares each file's compiled
  formulas against the current spec and the command names any that no longer
  match, with the remedy. Same principle as `last_reconciled` in §5.1: make the
  drift visible instead of assuming it away.

Read off the shipped app before building on it: Bases string literals accept
backslash escapes, `if(condition, true, false?)` is a global that nests, and
formula ids keep their `formula.` prefix inside a view where frontmatter ids are
written bare — all confirmed with a probe file in Obsidian 1.12.7.

Publication, correspondence and catalogue stages still group by raw value: those
vocabularies have no spec to read labels from yet, and inventing one here would
put a second definition somewhere other than the vault contract.

### Added — phase A3, the mode HUD
The three hats become a control rather than a settings field (§7 A3).

- **Status-bar segment** showing the hat being worn — glyph plus word, never
  colour alone. Click it to cycle.
- **`Ctrl/Cmd+1/2/3`** jump straight to a hat, plus commands to cycle and to
  toggle the filter. Obsidian flags a clash in its hotkeys pane and the user can
  rebind; shipping no default would leave the documented shortcut unwired.
- **Every board narrows to the hat**, with a hat switcher above the tabs.
- **A note with no `hat` shows under every mode and is flagged**, rather than
  hidden. Unattributed work is still work, and hiding it under all three hats
  would turn the filter into a way to lose a request. A hat we do *not*
  recognise — a typo — is filtered out, because that is a claim about which hat,
  just a wrong one, and folding it into whichever mode is on would bury it.
- **The filter always states what it is holding back** and offers the switch
  that reveals it, in the boards and on the status bar. A filter you cannot see
  is a filter that loses an overdue request, so `hatFilter` is a real setting,
  not a hidden switch.
- Settings schema v2: adds `hatFilter`, with the migration step and its trail.
- 119 further tests; 450 in total. 38 smoke checks. Bundle 156.5 KB.

### Added — A3, charts and bottleneck analytics
An **Analytics** board and `Show queue analytics`, answering §7 A3's list in the
order you would work through "why is the queue slow?": where the work is, how
long it sits, who is holding it, and whether governance is the reason.

- Queue by stage, median dwell per stage, dwell distribution, who the holdup is
  with, live work by hat, and a turnaround trend by completion month.
- **Governance risk is assessed by the workflow spec's own gates**, never by a
  second definition. A request counts as *blocked* only when every stage it is
  allowed to move to is gated shut; one open route means it can still progress.
  The chart ranks which gate refuses most often — the one worth fixing first.
  Re-implementing "needs a current IRB" in TypeScript would drift from the spec
  the first time the spec changed, leaving a governance instrument that quietly
  disagreed with the governance rules.
- Every series carries its own title, unit, denominator and empty-state
  sentence, and that is asserted in a test. §6 requires an explicit unit and a
  stated denominator on every chart; a rule enforced in the view holds only
  until somebody adds a second view.
- Rules that could be enforced in code are: bars always from zero, categorical
  order preserved rather than re-sorted by value, the emphasised part of a bar
  spelled out in words as well as shaded, and the trend's y-axis starting at
  zero with gaps left as gaps — a line drawn across a month where nothing
  completed asserts a trend through a hole.
- Terminal stages are excluded from median dwell: the clock stops the moment a
  request enters one, so "Delivered: 0 days" measures the rule, not the stage.
- **Effort by activity is not here.** It needs the effort log (B2), and the
  board says so rather than showing an empty chart.

### Added — A3, static HTML export
`Export board` writes the current board to `95 Exports/` as one self-contained
file that opens on a machine with no Obsidian, no plugin and no network.

- Styles inlined, no script, no external request of any kind — asserted in
  tests, because each of those would quietly break the only thing the file is
  for. Print stylesheet included, with `print-color-adjust` so the bars survive
  a printer's habit of dropping backgrounds.
- **Every document carries a provenance footer** naming when it was generated
  and stating plainly that it is not the official record — §5.1 is explicit
  that the institutional eData system remains authoritative, and a governance
  instrument that quietly contradicts the system of record is worse than none.
- The document states the hat it was filtered to and how many requests that
  hid, so a reader cannot mistake a filtered board for the whole queue.
- The three A3 guards and only those three: it always lands in `95 Exports/`,
  the confirmation names the file and the row count, and the write appends an
  `export` entry to the ledger. **No redaction machinery**, deliberately.

**Charts render from one source in both places.** A chart is built as a neutral
element tree in `domain/report/`; the cockpit maps it onto Preact's `h`, the
export serialises it to a string. Two hand-written renderers would drift, and
the one that drifts is the one nobody looks at until it is in front of a
committee. The alternative, `preact-render-to-string`, would have been a
dependency for something `element.ts` does in sixty lines. Escaping is the
serialiser's whole job: every value in a tree comes out of a note.

Board *tables*, by contrast, are a snapshot and not a clone of the interactive
board — cards you click do not become a document you print. What is shared is
the part that must not drift: the numbers, and the state vocabulary, which moved
to `domain/report/present` so a board cannot say "Overdue" on screen and
"breached" in the file.

### Fixed — found by running it
- **The mode hotkeys moved to `Ctrl/Cmd+Shift+1/2/3`.** CLAUDE.md §7 A3 asks for
  `Ctrl+1/2/3`, but Obsidian core already binds `Ctrl+1..8` to "Go to tab #N" —
  verified in 1.12.7, where the core binding wins and ours never fired. A
  shortcut that silently loses to a core binding is worse than a working one
  next door; the hotkeys pane still lets the user take `Ctrl+1..3` back.
- **The export confirmation named a file that was not the one written.**
  `plannedPath` returned the un-suffixed name while `write()` walked collisions,
  so a second export the same day promised `…-08-22.html` and produced
  `…-08-22-2.html`. Both now walk the same path. A confirmation that does not
  name the thing it is about to do is not a confirmation.
- **The chart grid forced a horizontal scrollbar below its track minimum.** A
  bare `minmax(320px, 1fr)` refuses to shrink, so the cockpit scrolled sideways
  in a 300px sidebar — the width §6 requires every view to survive. Now
  `minmax(min(320px, 100%), 1fr)`, in both stylesheets.
- **Stage labels no longer follow `retired:` on a board.** `resolveStage` maps a
  retired id to its successor so historical dwell still resolves, which meant a
  request stranded in `pending-approval` displayed as "Awaiting approval" —
  two stages under one heading, hiding the very note that needs migrating. One
  shared `stageLabelOf` now prints the raw id for anything not currently
  declared, matching the rule the generated `.base` files already follow.
- Blocking parties render as `Dr A Tan`, not `[[Dr A Tan]]`.
- The governance headline said "0 requests cannot move at all" when none were
  blocked. One shared sentence, and it says "No request is held up by a gate."

### Added — A3, the cockpit overview
An **Overview** tab, now the cockpit's first screen, and
`Show what needs attention`. Three lists, in the order you would read them.

- **Needs attention**, worst first, listing **every** reason that applies rather
  than only the worst. A request that is overdue *and* stranded *and* waiting on
  somebody is a different problem, not a worse one, and collapsing it to one
  chip hides the case the board exists for. A note the metrics could not fully
  trust ranks above everything else, because every other judgement here is
  computed from the fields it could not read.
- **Falling due** — any note carrying a readable date in the next 60 days,
  whatever its type, plus publications by `decision_due`. Generic on purpose: it
  covers event and obligation notes today, and when B3 materialises a next
  occurrence it lands as an ordinary date and this list picks it up unchanged.
  An obligation's `consequence` is shown, per §5.7 — a reminder that does not
  say what breaks gets ignored.
- **An obligation with a recurrence rule and no materialised date is reported as
  unscheduled, not dropped.** This build cannot compute a next occurrence (that
  is B3), and §5.7's whole point is that a lapsed obligation is the thing that
  must never be missed, so it is named rather than quietly omitted.
- **Publications in flight**, soonest decision first, from a §5.4 reader.
  `accepted` and `in-press` stay on the board — proofs, embargo and the
  open-access decision are still outstanding, and dropping them is how those get
  missed. Only `published`, `rejected` and `shelved` settle. Anything other than
  a literal `true` is not SCDB-supported: that number goes to a funding
  committee, so `scdb_supported: "yes"` must not become a claim.
- Two obligation fixtures (one dated, one recurrence-only) and the new unhatted
  request are swept by the real parsers in `tests/fixtures.test.ts`, which now
  also asserts every shipped obligation says what breaks.

The stage columns stay on the Queue tab. Putting them here as well would make
the overview scroll before it said anything, and the first screen of a cockpit
has to be the summary rather than the whole cockpit.

### Verified — A3 in a running Obsidian
Obsidian 1.12.7, test vault, after each fix above:
- Status bar shows the hat; clicking cycles it; `Ctrl+Shift+1/2/3` jump.
- Boards narrow to the hat, state what they are holding back, and the unhatted
  fixture (REQ-2026-009) appears under all three with its "no hat" chip.
- The Analytics board renders every chart at full width and reflows to one
  column at ~200px content width with no sideways scroll.
- Export wrote `95 Exports/Queue analytics-2026-08-22.html`, the notice named
  the file and the row count, the ledger gained an `export` row, and
  `Verify audit ledger` reported all three entries reconciling.
- The overview lists seven requests worst-first with their reasons, both
  obligation fixtures behave as intended (one dated, one reported unscheduled),
  and the publication appears with its decision 21 days overdue.

### Added — fixture verification
- **The shipped `test-vault/` fixtures are now parsed by the real parsers**, not
  by eye. `tests/fixtures.test.ts` sweeps every note and every workflow spec in
  the test vault and runs it through `parseRequest`, `parseSavedView`,
  `parseWorkflowSpec` and `validateQuery`, asserting zero problems. It also
  holds the fixtures to what they claim to test: a request must name a workflow
  spec that loads, must sit on a stage that resolves, and one must remain
  stranded on a stage with no `retired:` mapping — otherwise the migration
  view's hard path, where a human has to choose a target and type a reason, has
  quietly stopped being exercised. Proved by breaking each class of fixture in
  turn and watching it fail. 18 tests; 311 in total.
- `js-yaml` as a **devDependency**, pinned to `^4.1.0`. Obsidian's `parseYaml`
  is js-yaml v4 — the shipped app bundle carries its
  `renamed("safeLoad", "load")` v4 deprecation shim — so matching the library
  and the major is the point of the exercise. **Bundle cost is zero:** nothing
  under `src/` imports it, and `main.js` is unchanged at 117.2 KB.

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
- **A hand-rolled YAML parser was rejected for the fixture guard.** A subset
  parser would eventually accept a fixture Obsidian rejects, and a guard that is
  confidently wrong is worse than the documented gap it replaced. That is what
  justified a dependency here, dev-only and zero-bundle.

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
