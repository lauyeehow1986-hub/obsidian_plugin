# Changelog

All notable changes to SCDB Cockpit. Governance-gate changes get their own
clearly marked entry (CLAUDE.md §10).

## Unreleased

### Added — F2, a live R and Python console

A long-lived interpreter in a pane, with a transcript, an environment list, a
plot pane and a visible busy state. **Open the interpreter console**, plus
**Send a code block from this note to the console** and an editor right-click
item beside the existing Run one.

**Nothing the console produces reaches the vault.** No run record, no ledger
row, nothing written into a note — §5.12 keeps exploratory console lines out of
the ledger, and a ledger nobody can read is not a ledger. The trade is stated in
the pane itself: to keep a result, put the code in a block and run it (F1),
which produces a record naming the interpreter, the script hash and the data
version. Verified by running a session end to end and confirming `94 Runs/` was
still empty and the ledger untouched.

**Attribution is arranged, not inferred.** No prompt detection anywhere: the
harness announces the end of every cell with a marker carrying a token generated
for that session, on *both* streams. Ending a cell on stdout alone loses the
race whenever a traceback is still in flight — the error would land in the next
cell's output, which is worse than no attribution at all.

**Cells are serialised, and that is load-bearing rather than tidy.** The next
command reaches the pipe only once the previous cell has reported. An R cell can
read the process's stdin, and with a command already sitting there it consumes
it: driven that way in a test, `readLines(file("stdin"))` ate the following
cell's command and the session ran on attributing every later result to the
wrong code. Keeping the pipe empty while a cell runs leaves such a cell blocked
instead — visibly, with Stop available. Python needs no such care because its
`sys.stdin` is swapped out for the duration of a cell.

**There is no interrupt on Windows.** `SIGINT` to a real Python session sleeping
for 30 seconds terminated it. So the control is **Stop session**, named for what
it does; a button labelled "Interrupt" would discard an environment while
claiming not to. **Restart** is one click, because §7 F2 asks for it to be one
click rather than a last resort.

**Readiness is confirmed rather than assumed.** Starting sends one empty cell of
the plugin's own and waits for its marker, so a broken interpreter fails at
startup with its own message instead of on somebody's first real cell.

Two harness defects found by running it, both R:

- **Every cell reported a figure.** R's `png` device writes a complete, valid,
  blank image the moment it is opened, so a file appearing proves nothing and
  the plot pane filled with white rectangles. It now enables the display list
  and asks `recordPlot()` what was actually drawn.
- **The harness leaked a variable into the environment pane.** R's `for` and
  `repeat` assign in the enclosing environment, so the loop's own counter landed
  in `globalenv()` beside the person's data. Everything is now inside one
  `local()`, which leaves nothing to filter.

And one in the protocol, found by a test rather than by use: markers used to be
written on their own line and the parser took the separator newline back off,
which worked only while both arrived in the same chunk. When the boundary fell
between them a blank line appeared before the result — intermittently, on OS
chunking. Markers now carry no newlines at all, and a test pushes one through at
every possible split.

No new settings and no schema change: the console reads the same interpreter
paths, isolation and output cap as F1, through one accessor so the two can never
disagree about which Python is meant.

### Fixed

- A restart leaked its working directory. On Windows a just-killed process has
  not necessarily let go of its current directory, so the first removal fails
  with `EBUSY` and the failure was being swallowed by design. Removal is now
  retried; verified by restarting twice and finding one directory, not three.
- Reopening a pane that Obsidian had restored but not yet loaded made a *second*
  one. Obsidian defers loading a restored pane, so `leaf.view` is a placeholder
  and the `instanceof` check that looked for an existing pane skipped it — seen
  in the app as two console tabs, which means two interpreters running and a
  "send to the console" arriving in whichever one you are not looking at. The
  pane is now revealed before the check. The vault-app pane had the same bug,
  where a second pane means a second sandbox with its own grants, and is fixed
  with it.


### Added — F1, running R and Python blocks with provenance

Run an R or Python block from a note. Output, errors and plots come back under
the block; a §5.12 run record is written to `94 Runs/`; the ledger gets a
`code-run` row. Reachable three ways: a **Run** row under the block in reading
view, **Run this R/Python block** in the editor's right-click menu, and the
**Run a code block from this note** command.

**Nothing runs by surprise** (rule 12). Opening a note runs nothing, loading the
vault runs nothing. Every route leads to a dialog that shows the whole block,
names the interpreter, says where it will run and what it will write — and only
then offers a button. The code is shown in full rather than summarised, because
a block in a note somebody sent you is untrusted input and a person reading it
is the only defence there is.

**Interpreter hardening, and what running it actually proved.** `Rscript
--vanilla` and `python -I`, `spawn` with `shell: false` and array arguments,
and a temporary working directory outside the vault. Each of those was checked
rather than assumed:

- An `.Rprofile` planted in the working directory — §7 F1's stated threat, a
  file arriving from a colleague's zip — **does not execute** under `--vanilla`.
- `-I` keeps both the working directory and `PYTHONPATH` off `sys.path`, so the
  `random.py`-shadows-the-stdlib problem is closed.
- `-I` also implies `-s`, which hides anything installed with `pip install
  --user`. On the dev machine that meant **no matplotlib and therefore no
  plots**, with nothing to connect the two. So the "test interpreter" button
  reports the packages it can see as well as the version, and a second
  isolation setting keeps `-E -P` — the part the spec argues for — while
  allowing the per-user site directory. The hardened option remains the default.

**Plot capture by harness, not by hope**, and the first version of that was
wrong in a way only running it showed. The figure sweep was an `atexit`
handler; importing `matplotlib.pyplot` registers an atexit handler of its own
that closes every figure, user code imports pyplot *after* ours is registered,
and atexit runs LIFO — so matplotlib destroyed the figures first and the sweep
found an empty list, silently. It now runs in a `finally`, which has no
ordering to get wrong and still fires when the block raises. That is the run
whose plots you most want.

**Errors name your line, not the harness's.** Both runners execute the block
from its own file, so a traceback reads `block.py line 3` and an R error reads
`Error on line 3`. R warnings are reported through a calling handler that
muffles and resumes: `tryCatch` on a warning unwinds, which would turn a
cosmetic warning on line 2 into forty lines that silently never ran.

**Python displays the last expression only**, the way a notebook cell does.
Displaying every one, REPL-style, meant a block that drew a chart printed five
lines of matplotlib repr around two lines of output. R keeps printing every
visible result, which is R's own behaviour and quiet there because its plotting
calls return invisibly.

**Every run is out of process, timed and killable.** A Stop button ends it, and
`killed` is recorded distinctly from `timeout` — one is a person deciding they
had seen enough, the other is the machine deciding for them, and a record that
conflated them would lose the difference. Output is capped per stream, cut in
the middle rather than at the end, because the tail of a traceback is the part
worth keeping.

**Output in the note is replaced, never stacked**, and the region that gets
replaced is defined narrowly enough that it can only match something this
plugin wrote: our own `text scdb-run` fence immediately after the block, plus
embed lines that are only an embed of a figure in the runs folder named after a
run. The first line that is anything else ends the sweep, so a person's note
under a block survives a re-run (rule 8). The fence is plain `text`, so a vault
opened without the plugin reads the same.

**The run record is an observation, not hearsay.** It carries `ran_by` and logs
`code-run`, where a hand-recorded run (§7 C3) carries `recorded_by` and logs
`run-recorded`. An auditor reading `94 Runs/` needs to know which they are
holding. The record also keeps a verbatim copy of the code that ran, fenced
`no-run`, so `script_hash` can be *checked* rather than merely compared once
the note has moved on.

A block fenced `no-run` is never offered — for the archived copy in a run
record, and for the block in an SOP that illustrates what not to do.

Settings schema **9 → 10**, with a migration. Neither interpreter path is set
on upgrade: §7 F1 forbids assuming `PATH`, the target machine has neither on it,
and a guessed path means a run against an interpreter nobody chose, recorded in
a provenance record as though they had.

**Still open (§11):** the real `Rscript.exe` and miniconda `python.exe` paths on
the work laptop. They are settings values, not code — the "test interpreter"
button answers them in ten seconds on that machine.

### Changed

- The reading-view Run control moved out of the code block to a row beneath it.
  Obsidian's code blocks are scroll containers, so an absolutely positioned
  child anchors to the scroll height: the button sat below the visible box and
  was clipped away. Out here it cannot be clipped and does not compete with
  Obsidian's own copy button for the corner.


### Added — F3, vault apps, the scratchpad and app export

An **Apps** tab over `92 Apps/` (§5.13), a sandboxed pane that runs them, and
five commands: **Show the vault apps**, **New vault app**, **Run a vault app**,
**Export a vault app with its data** and **Open the JavaScript scratchpad**.

§7 F3 asks for three surfaces on one runtime, and this is all three: a saved
mini-app, a scratchpad you type into, and a self-contained HTML export. They
share one sandbox, one broker and one runtime, because two hosts would drift
and the differences would be in the guards.

**The frame is where the guarantees live.** `sandbox="allow-scripts"` with no
`allow-same-origin` gives an app an opaque origin: no access to this document,
no `localStorage`, no Obsidian. What that attribute does **not** do is stop a
network call — a sandboxed frame can still `fetch()` a public host, or point an
image at one with the data in the query string. So the page also carries a
`default-src 'none'` content-security policy with `connect-src 'none'`. Rules 3
and 4 rest on both together, and the shipped overreach fixture calls `fetch()`
and prints the refusal so that stays true rather than being assumed.

**Nothing live crosses the boundary.** §5.13 forbids passing `App`, `Plugin`,
`Vault` or `adapter` into an app — `app.vault.adapter` is arbitrary filesystem
access, and handing it over would make the manifest decorative. An app gets a
message port and a pre-bound runtime: `html` (htm already bound to Preact),
`render`, the hooks, and `useQuery` / `useNotes` / `useProposeWrite` with plain
`query` / `notes` / `proposeWrite` beside them for code that runs on a click
rather than during a render. Preact, hooks and htm are bundled separately into
17 KB of source text and injected into the frame, because there is no module
loader and no origin to fetch a second file from on that side.

**Consent is recorded against a hash of what was granted, not against the app.**
The manifest lives in a note, so it can be edited later — by you, by an update,
or by whoever sent it to you. Every run compares. Widening re-prompts and names
exactly what changed ("it now also wants to read correspondence"); narrowing
does not, because asking about less would train you to click through the dialog
that matters. Re-ordering the type list is not a change. The consent lives in
settings rather than in the note: a consent stored next to the thing it
authorises is not a consent.

**An app proposes; it never writes.** `write: propose` lets an app offer a
change, which is shown in full — the note, every field that moves, both values,
and the app's stated reason quoted as *its* claim — and written only if you
confirm. An app may only propose changes to note types it may read, or one
granted type plus `propose` would be write access to the whole vault. `uid`,
`type` and `history` are refused whatever the manifest says: history is what
every dwell, bounce and turnaround figure is computed from, and corrupting it
would not break anything visible, it would quietly change the numbers in a
report.

**`network: true` is refused, not honoured.** Rule 3 says outbound traffic goes
through one gateway that is off unless a specific module is enabled, and no app
is that module. A manifest asking for it parses, reports the request on the
board and in the consent dialog, and is granted `false`.

**Nothing runs by surprise** (rule 12). Opening an app note runs nothing;
loading the vault runs nothing; the scratchpad opens stopped. The board shows
what an app may reach and its code before offering to run it.

**Export carries a snapshot, and says what it left out.** A self-contained page
in `95 Exports/` — the app plus frozen data, no network request, opens in any
browser. Correspondence notes and correspondence-derived fields are excluded by
default per §5.10, and the confirmation names what was dropped: a page that
quietly lost half its data is one nobody can explain to the person they sent
it to.

**The watchdog is honest about what it buys.** It pings; an app that stops
answering is offered for teardown. §11's F3 question — whether this Electron
build isolates a sandboxed iframe into its own renderer process — is still
open, and it decides whether a runaway loop stalls only the app or the whole
window. If it is the latter the watchdog's own timer will not fire either, so
this detects a *wedged* app, not every possible one.

Two new ledger actions (§5.6): `app-granted` when an app is allowed to run or
its permission is withdrawn, and `app-write` when a proposal is confirmed. The
write itself is a `bulk-edit`; `app-write` records that an app was the origin,
which is the part a reader cannot reconstruct from the note afterwards.

Settings schema **8 → 9**, with a migration. The upgrade grants nothing, every
unreadable stored grant is dropped rather than trusted, and there is no "trust
all apps" switch — it would be one click, taken on a busy morning, and it would
turn every later manifest edit into something that happens silently.

### Changed

- The fenced-block reader D2 wrote for `yaml redcap` moved to
  `domain/markdown/fence.ts` and now serves the `js app` block too. A second
  copy would be a second place to get "replace only the block, never the prose"
  subtly wrong, and that rule is what keeps rule 8 true for both note types.


### Added — D2, REDCap form designer (data dictionary half)

A **Forms** tab over `88 Forms/` (§5.14), and four commands: **Show the REDCap
forms register**, **New REDCap form**, **Export a REDCap data dictionary** and
**Import a REDCap data dictionary**.

§7 D2 orders its three deliverables deliberately, and this ships the first two.
The **project ODM XML export is not here and was not attempted**: §11 blocks it
until a real project XML exported from the target instance exists to build
against, because those files carry REDCap extensions that vary by version and a
guessed schema is a file REDCap rejects at the last step.

**Validation is the value, and it runs before any export.** Field names against
REDCap's shape, length and reserved list, and unique across the whole project
rather than per instrument — the namespace is the project, and a per-instrument
check exports two `dob` columns and fails on upload. Choice lists well-formed
and codes unique. Branching logic and calculations checked against the fields
they name: brackets and quotes balance, a checkbox is referenced as
`[field(code)]` and a non-checkbox is not, and the code inside is one the
checkbox actually offers. That last one matters most — a condition naming a
renamed choice code uploads happily and then never fires, so the field never
shows and nobody finds out until the data comes back empty.

**Two severities, and the line between them is whether REDCap will take the
file.** An error blocks; a warning is shown and exported past. Blocking on
warnings would train the person to override, and an override that becomes
routine has stopped being a control.

**The governance hook is why this is here rather than in any form builder.**
Every field flagged as an identifier is checked against the linked study's
approved scope. One finding blocks — an identifier on a study approved to
collect none — and exporting anyway takes a typed reason that lands in the
ledger as a `gate-override` beside the `export` entry (§5.6). The rest ask:
an identifier neither the field nor its catalogue variable justifies; a field
that *looks* like a direct identifier and is not flagged, labelled as the guess
from the name that it is; and a field disagreeing with the catalogue about
whether the thing is an identifier at all, with neither treated as
authoritative.

**Silence is not approval.** A form naming no study, or naming one that records
no `governance.identifiers`, reports its identifiers as *uncheckable* — not a
pass and not a block. The same rule C3 applies to a script with no recorded run
and C2 to a definition nobody dated. Reading a missing scope as `none` would
produce loud false alarms that get ignored; reading it as permissive would
approve by silence, which is worse.

**A validation error cannot be overridden at all**, because there is nothing to
weigh: REDCap will reject the file, and an override that produces a broken
artefact wastes the person's time twice.

**Import exists so an existing instrument can be edited rather than rebuilt**,
and it reports what the format could never have carried — the catalogue
variable a field collects, and why an identifier is held. A dictionary arrives
with both blank, which is a list of questions, not a defect. Logged as a
`bulk-edit` naming the counts on both sides.

**New note types read, none invented.** `type: redcap-form` (§5.14) keeps its
identity and links in frontmatter and its instruments in a ```` ```yaml redcap ````
block in the body, per §7 — too large for frontmatter, and it diffs cleanly.
Only the block is ever rewritten; the prose around it survives untouched
(rule 8, §5.1). `type: study` in `20 Studies/` is read for the first time, and
reuses §5.1's `governance.identifiers` vocabulary exactly — a request says what
that request asks for, a study says what the approval permits, in the same
words.

CSV quoting moved from `domain/query/format.ts` to `domain/table/csv.ts`
alongside the parser import needs, so an emitter and a reader of one file
format cannot drift apart. Round-tripping is tested per §9 — export → import →
export is byte-identical, on a synthetic form and on a shipped fixture.

### Fixed

- An unquoted `min: 2026-01-01` in a form block arrives as a `Date`, because
  YAML's default schema resolves a bare date scalar and nobody quotes one. It
  was being dropped, leaving a field looking unbounded on the board and
  exporting an empty column. Now read, and formatted in UTC — YAML puts a
  date-only scalar at UTC midnight, so a local-time formatter would shift the
  bound by a day anywhere west of Greenwich.


### Added — C3, script documentation and versioning

A **Scripts** tab over `50 Scripts/` (§5.14), answering the one question §7 C3
sets: *which of these needs re-running before anyone quotes its output again.*

Rows are grouped by verdict, worst first, because any other grouping buries that
question. Each opens onto what the script reads, the catalogue variables it
consumes, what it produces, and every `94 Runs/` provenance record that points at
it — with the interpreter and the hash each run actually executed.

Four commands: **Show the script register**, **New script documentation**,
**Record a script run**, and **Check a script's file hash**.

**Six findings, and the order between them is deliberate.** `run-failed` leads
because it is the only one where the outputs may not exist at all; a number that
was never produced is not the same problem as an old one. `definition-moved`
outranks `inputs-moved` because a changed definition means the numbers mean
something different, not merely that they are stale. Then `code-moved`,
`never-run`, and `undated`.

**Silence is not freshness.** A script with no recorded run, or with runs that
carry no date, is not reported as current — it is unanswerable, and it gets a
finding saying so. Nothing is compared against a date the vault does not have.
Same rule the catalogue applies when resolving a past definition: the honest
answer to an unanswerable question is "not recorded", never the reassuring
default.

**The C2 join asks the time question, not the version question.** A script citing
`VAR-LVEF@2` while the catalogue is at 3 is C2's `stale` finding and stays on the
catalogue board. C3 adds what a version ref cannot tell you: the definition came
into force *after this script last ran*, so its outputs were produced under the
earlier one. That fires even when the citation names no version at all — which is
the common case, and the one nothing else could catch.

**A run that recorded no hash is not treated as a match.** Both hashes have to be
present before `code-moved` can fire; a missing one means the run cannot say the
code is unchanged, and the run's own record reports that gap rather than passing
silently. Likewise the documented `file_hash` and the hash a run executed are
kept apart: the first proves the documentation is current, and only the second
proves what made the numbers.

**The hash is only ever read from inside the vault.** `file:` may point at a
portable R build's folder or a network share, and reaching those means `fs` and a
path outside the vault — the boundary rule 8 draws. An outside path is reported
as uncheckable from here rather than quietly resolved. Adopting an observed hash
onto the note is a separate confirmation, because seeing that the code moved and
declaring the new version documented are different decisions.

**New note types read, none invented.** `type: script-doc` (§5.14) gains
`purpose`, `file`, `file_hash`, `hash_checked`, `inputs` (each with a `changed`
date, which is what a comparison needs — a version string is what a human
quotes), `outputs`, `last_run` and `last_run_by`. `type: run` (§5.12) is now
parsed for the first time; F1 will write them, and until then C3 does.

Two keys beyond §5.12's example, on the same argument as `composed_only: true` in
§5.10: **`recorded_by`** and **`recorded`**. The plugin did not run anything — it
wrote down that a person says they did — and the record should say so.

#### Ledger — a new action

`run-recorded` joins the vocabulary, deliberately distinct from `code-run`.
§5.12 logs `code-run` for an execution the plugin performed; a run typed in
afterwards is hearsay, and an auditor weighs the two differently. One action for
both would destroy the only information that lets them. Recording a run appends
`run-recorded` with the run id, exit state and input/output counts — never
content (rule 7).

Recording a run refuses only what would make the record meaningless: a script it
cannot point at, and a run it cannot place in time. A missing interpreter or hash
weakens it considerably, and the dialog says so under *"What this record will not
be able to say"* — but refusing over a forgotten R version would mean no record
at all, which is strictly worse.

### Added — C2, the variable catalogue

The management UI over `87 Catalogue/` (§5.8): browse and search the catalogue,
supersede a definition with a recorded reason, see what rests on each variable,
and answer **"which definition was in force on this date"**.

A **Catalogue** tab in the cockpit lists variables grouped by domain. Each row
opens in place onto three things: the definition and its coding or range, the
version chain with what moved at each step and why, and every note in the vault
that cites it — grouped by whether it is a study, a form, a request, a script or
a run.

Four commands: **Show the variable catalogue**, **New catalogue variable**,
**Revise a catalogue variable**, and **Which definition was in force**.

**A revision supersedes; it never overwrites.** The current definition is pushed
down into the note's own `history` — stamped with the version it was and the
date it came into force — and only then does the head change. Both halves land
in one `processFrontMatter` call, so unlike a policy revision there is no window
where one exists without the other.

**Two additions to §5.8's frontmatter, both because C2 has to answer something
the example cannot express:**

- **`history:`** — the definitions that came before. §5.8 carries `version` and
  `supersedes: VAR-LVEF@2`, which name a prior version without saying what it
  *said*. A pointer to a version number cannot answer what a variable meant when
  an extraction ran, so the superseded text lives on the note in the same
  append-only shape a request's `history` uses.
- **`justification:`** — free text recording why an identifier is held. Required
  by nothing, but it is what the board points at when `identifier: true`, and it
  is the same answer D2's form export has to give against the study's approved
  IRB scope.

**Past values are never borrowed backwards.** Resolving an old version folds
*forwards* from the start of the chain, and a field the chain never recorded by
then resolves to "not recorded at that version" rather than to today's value.
Answering "what did this mean in 2023" with the 2026 definition is the exact
failure this feature exists to prevent, and it would be invisible — the answer
would look confident and be wrong. The dialog says which fields it cannot
answer, and names any undated version in the chain it had to skip. It does not
list a field the data type rules out — a numeric variable has no coding, and
"coding not recorded" is true, useless, and buries the case that matters. When
the data type itself is unrecorded, nothing is ruled out.

The lineage table's "what moved" column compares resolved states rather than
listing what an entry happened to write, so the current version does not claim
that the coding changed on a variable that has never had any.

**Citations are read from both ends**, the same argument as the policy register:
a variable names the studies that collect it and the form that captures it,
while any other note names what it consumes in `variables:`. Three findings come
out of that join and are counted on the board:

- a citation naming a version the catalogue has **moved past** — the script's
  claim was written against a definition that has since changed;
- a citation naming **no version at all**, which is not stale but is unrecorded,
  and is reported separately because it calls for a different action;
- a citation naming a variable the catalogue **does not hold** — a typo, or
  something being consumed that was never catalogued.

Chain problems are reported apart from field problems: a duplicated version, a
gap, a `supersedes` naming the wrong version, dates running backwards, or a
version bump that kept no history. That last one is the common hand-editing
failure — bumping `version:` in the frontmatter silently discards what the
variable used to mean.

**Governance:** a revision requires a typed reason, on the same rule as a gate
override (§5.6) and a policy revision. It appends a `variable-revision` entry to
the audit ledger — a new action, added for the reason `policy-revision` was: an
auditor asks "when did this definition change, and who changed it", and an entry
answering it has to be findable by action rather than by reading every detail
cell. A revision that moves the identifier flag appends an **`identifier-scope`
entry as well**, because §5.6 names that action in its own right and one
combined entry would technically record the fact while practically hiding it.
Ledger details carry field names and counts, never the definition text (rule 7).

Test-vault fixtures ship with each finding staged against a real note: a
three-version variable whose first version recorded only a definition, a
categorical with coding, an identifier with no justification, a variable bumped
to version 2 with an empty history, and a script doc whose three citations are
stale, unversioned and orphaned respectively.

### Added — D1, the flowchart builder with PowerPoint export

A structured node/edge editor writing a `type: diagram` note in `89 Diagrams/`,
compiled to Mermaid, rendered through Obsidian's **core** Mermaid support, and
exported three ways: an `.svg` beside the note, a PNG at 2× or 3× into
`95 Exports/`, and — the one that actually matters — **a PNG straight onto the
clipboard**, ready to paste into a slide.

**The differentiator is generating diagrams from data already held**, and three
generators ship:

- **The request lifecycle, drawn from the workflow spec.** The process as
  configured, not as remembered. Stages carry their owner and SLA target, gated
  stages are marked and carry the gate's own refusal message, and send-backs are
  drawn dotted. A stage the spec leaves unconstrained gets one dotted arrow
  labelled `unconstrained` rather than an arrow to all eleven others — §5.2
  forbids quietly inventing a constraint the spec does not state, and saying
  "unconstrained" out loud is the honest alternative to a hairball.
- **The path one request actually took, drawn from its `history`.** Not the
  lifecycle with a highlight on it: repeated visits to a stage are repeated
  arrows, each labelled with what the previous stage cost, and a bounce count
  goes in the title. §5.1 asks for dwell, age and bounce count together, and a
  tidy lifecycle diagram is exactly what hides the third. Migration relabels are
  folded away first, so renaming a stage never draws as a journey.
- **A data-flow map for a governance submission**, built from a request's own
  governance fields. Counts, year ranges, identifier scope and instrument states
  only — never a name or a record id, on the same reasoning §5.11 keeps
  identifiers out of composed URIs, because a diagram is a file that travels. An
  **unmet control is drawn, not omitted**: a missing DUA on an identifiable
  extraction is the loudest box on the page, because a data-flow diagram that
  quietly leaves out the control nobody obtained is worse than no diagram.

Generated diagrams stamp `generated_from` (`edata-request@3`, `REQ-2026-014`) and
`generated_at`, and a **Redraw** button rebuilds from source. That stamp is the
point: a lifecycle drawn from spec v3 and still in the vault after the spec moves
to v4 is a picture of a process nobody follows, and it should be detectable
rather than merely wrong. Redraw returns nothing rather than guessing when the
source has gone — a redraw that silently produced an empty diagram would look
like the process had been deleted.

**Rendering goes through `window.mermaid`, not `MarkdownRenderer`, and the
reason matters.** §7 D1 specifies rendering the fence with
`MarkdownRenderer.render` and lifting the `<svg>`, which is the documented
route — and on the machine this was built on it produces no SVG at all, in a
detached host or an attached one, with no error raised anywhere. A4's Mermaid
probe reported the same thing, which is precisely why §7 A4 asks for risky
integrations to be probed rather than assumed. Obsidian exposes its own bundled
Mermaid as `window.mermaid`, so the diagram is rendered by calling that
directly: still core Mermaid, still no diagram library of ours and no bundle
cost (rule 2, §3), and it returns the SVG as a string, which removes the polling
and the timeout with it. The `MarkdownRenderer` route stays as the fallback if a
future Obsidian stops exposing the global.

**Obsidian loads Mermaid lazily**, so `window.mermaid` is undefined on a fresh
start and only appears once something has rendered a fence. The renderer
therefore warms it up with one throwaway `MarkdownRenderer` render before
reaching for the global. The A4 probe does the same warm-up and exercises the
same path — a diagnostic that reports on a route the feature does not take is
worse than none.

**Palette colours are converted to hex before they reach Mermaid, and refused if
they are not.** `classDef` takes a comma-separated list, so a theme colour that
resolves to `hsl(258, 88%, 66%)` — which is exactly what Obsidian's default
accent does — turns one style declaration into four and fails the whole diagram
with a parse error. The renderer normalises through a canvas context; the
emitter refuses anything still carrying a comma, a space or a semicolon and
falls back, so a caller who forgets cannot produce a broken diagram.

**Labels are escaped, and this is the reason the Mermaid emitter is its own
module.** Every label comes from vault content — a note title, a person's name, a
stage label out of a YAML file somebody emailed over — and Mermaid treats markup
in a label as markup when HTML labels are on. §8 forbids putting vault-derived
content through `innerHTML`; handing it to Mermaid unescaped is the same act with
an extra step. Labels are escaped character by character into Mermaid's decimal
`#nnn;` entity form in a single pass (a second pass would mangle the `#` of every
escape the first one wrote), and node ids — also hand-editable — are reduced to
`[A-Za-z0-9_]` before they can become syntax, with a collision counter so two ids
folding onto the same safe form stay apart.

**An edge pointing at a node nothing declares is dropped and named.** Mermaid
would otherwise invent a box labelled with the raw id, and an invented box in a
governance diagram is the sort of thing that gets believed.

**Never colour alone** (§6): each state prefixes a glyph onto its label, so a
diagram still reads in greyscale, for a colour-blind reader, and in a PNG pasted
into a deck nobody re-colours. Colours come from the same six-state semantic
palette the boards use, resolved out of the live theme at render time and baked
into the export as literal values so an exported file is self-contained.

**Nodes and edges live in frontmatter, and the body carries a Mermaid block the
plugin maintains** between `%% scdb:diagram %%` markers. Frontmatter because
§5.1 makes it the source of truth and `processFrontMatter` merges key by key so
unknown keys survive (rule 8); the generated block because rule 11 asks that
everything written stay markdown a human can read and undo — uninstall the
plugin tomorrow and core Mermaid still draws the picture. Prose outside the
markers is never touched.

The editor pane deliberately does **not** override `getState`/`setState`.
Carrying our own key in the persisted view state is the obvious way to make the
pane survive a restart, and it is what this view did first: the result was a
view whose container Obsidian never attached, so the pane opened blank with no
error anywhere. The pane is a workbench rather than a document — losing it on a
restart costs one command, and `CockpitView` has the same shape for the same
reason. A newly created diagram is handed to the pane directly rather than read
back, because Obsidian's metadata cache is asynchronous and a note written a
moment ago is not in it yet.

Commands: *New flowchart*, *Open the flowchart editor for this note*, *Draw the
workflow lifecycle*, *Draw what actually happened to a request*, *Draw the data
flow for a request*.

### Changed — the exporter

`Exporter` grew a `writeBinary` path for the rasterised PNG (a picture handed to
`vault.create` as a string is a corrupt file) and accepts `svg` as a text
extension. Both take the same guards as every other export: the exports folder,
the collision walk, and an `export` entry in the audit ledger (§5.6). The `.svg`
written beside a diagram note is the one export that does not land in
`95 Exports/` — §7 D1 asks for it next to the note, and it is regenerated from
the note each time, so it replaces rather than dating. The ledger row is written
either way.

Saving a diagram note appends **nothing** to the ledger. It changes no stage,
satisfies no gate and moves no identifier scope, and §5.12's precedent is that
padding the ledger with things nobody needs to read is how a ledger stops being
read. Exports are logged, every one.

### Changed — diagnostics

A4's core-Mermaid probe now exercises the path D1 actually uses: it warms
Mermaid up, then calls `window.mermaid.render` and checks for an SVG, falling
back to the `MarkdownRenderer` route only when the global is unreachable. It
previously reported "could not confirm" on a machine where diagrams render
perfectly well, which is the kind of false finding that teaches people to ignore
a self-test.

### Added — C1, the policy register and revision tracking

Drop a reissued policy into the vault, and the plugin freezes the version it is
replacing into `40 Policies/_revisions/`, diffs the two, and writes an **impact
map** naming what in this vault now has to be looked at. §7 C1 is explicit that
the impact map is the deliverable and the diff is only how it is computed, and
that is how this is built.

**The clause is what makes the map worth having.** A dependency declares which
clause it rests on — `governs:` on the policy, or `derives_from:` on whatever
depends on it — and a change to clause 5.2 then flags the three things resting
on 5.2 rather than the forty resting on the document. A dependency may be
declared from *either* end, because whoever writes a local SOP is the person
who knows it implements clause 5.2 of something, and making them edit the
institutional policy note to say so is how an impact map ends up empty.

Four verdicts, and the vocabulary is the governance content:

- **Clause gone** — it cites a clause the new version no longer contains. The
  loudest state there is: the dependant still reads as governed and the rule it
  named has ceased to exist.
- **Affected** — it cites a clause, and that clause moved.
- **Review** — it cites no clause, so the change *cannot be ruled out*. Not
  "probably fine". A map that quietly assumed otherwise would be worse than no
  map, so an unattributed dependency is never reported as unaffected.
- **Clear** — it cites a clause and nothing matching it moved. The only verdict
  that lets something off, and it is earned.

The report also names changed clauses **nothing** claims to rest on, which is
more often an undeclared dependency than a free clause, and marks any reference
that resolves to no note. Clause numbers are read off headings and never
invented: `### Definitions` under `## 5.2` is not clause 5.2.1, because a
number in an impact report that appears nowhere in the policy is the kind of
confident fabrication a governance instrument cannot afford.

**Refusals, before anything is written.** A policy with no `version` has
nothing to file a frozen copy under; a document identical to the current text
is not a revision; and a revision with no one-line summary is a record nobody
can act on later, so it is refused for the same reason §5.6 refuses a gate
override without a typed reason. Reissue under the same number is a *warning*,
not a refusal — issuers do that, and the frozen copy takes a dated name so the
two can be told apart rather than one overwriting the other (rule 8).

**Freeze first, replace second.** A crash between the two leaves a frozen copy
that duplicates the live note, which is harmless; the other order loses the
prior text, which is the one thing this track exists to preserve.

The **policy register** (a new Policies board, and *Show the policy register*)
reports what the impact map cannot, because the impact map only exists on the
day something is revised: what is in force, what is overdue for review, and the
two findings that catch people out — a policy nothing declares a dependency on,
whose revision would produce an empty impact map, and a policy never frozen,
whose first revision would have nothing to diff against. **Freeze the current
version** answers the second without inventing a change. A policy's `review_due`
also now feeds the existing deadlines board, the briefing and the ICS export,
because it is a date that falls due like any other.

### Changed — audit ledger

A new `policy-revision` action. §5.6's list did not name it because C1 came
later; it earns a row of its own rather than borrowing `bulk-edit`, because the
question an auditor asks is *when did this rule change, and who changed it*, and
an entry that answers it has to be findable by action rather than by reading
every detail cell. Adding to the vocabulary is backwards-compatible: existing
ledger files parse and their chains still verify.

### Added — B7, report generation, the CV and the research profile

One engine, five templates. A new command, **Generate a report**, picks a
template, asks for whatever that template needs — a month, a year, a study —
and writes a document into `95 Exports/`.

A template is data, not code: prose, named data blocks and live A2 queries, in
the order they should be read. The five B7 names ship compiled in, so the
feature works in a vault that has never seen `_config/reports/`. **Write the
built-in report templates to _config** copies them out for editing; a file
there replaces the built-in with the same `id`, or adds a new one under a new
id. Existing files are never overwritten, and nothing is written to the vault
until you ask (rule 3).

- **Monthly facility report** — queue, turnaround, effort and bottlenecks.
- **Per-study effort statement** — hours by activity, person and request, plus
  estimate against actual. The chargeback line.
- **Annual publication list** — the formatted list for one year with the
  facility's contribution beside it.
- **CV** — composed from `85 Publications/` and `84 Profile/`, in the
  configured citation format. It is a query, so it is never out of date.
- **Research profile** — the narrative version of the same data: headline
  metrics, themes, collaborations, what the facility contributed.

**Two words in a template mean two different things, and keeping them apart is
most of the design.** *Period* is *when*: it filters what happened — effort
entries, and which year's papers are listed. *Study* is *what about*: it scopes
the whole report to one study's requests, effort and papers. The queue honours
neither, and says so on every report that shows it — a queue is a snapshot of
now, and reconstructing the one that stood on 31 July is a claim this engine
does not make.

**Two output formats, because they are read in different places.**

- A **markdown note**: pipe tables you can edit, sort in a Base and paste into
  an email, and charts as embedded SVG. It carries frontmatter (`type:
  scdb-report`, the template, the period, the row count), so a generated report
  is a note the index and the query engine can see rather than a dead artefact.
- A **self-contained HTML page**, as A3 already wrote boards: one file, no
  network, opens on a machine with no Obsidian, prints, and exports to PDF from
  the browser.

Charts render twice from one set of numbers. The trend's geometry is computed
once and drawn by two renderers — the themed one the cockpit and the HTML
export share, and a standalone-SVG one for markdown, which has no stylesheet to
hang a class on. The SVG variant draws in `currentColor` throughout, so it is
legible in light and dark and in whatever theme the work laptop wears.

**Profile notes are new, and they are the CV's whole source (§5.9).**
`84 Profile/` takes one note per grant, service role, course, trainee,
presentation and award — ten seconds each, added as they happen. Nothing
CV-specific lives anywhere else, so adding a section to a CV never means
re-entering data. Seven synthetic examples ship in `test-vault/84 Profile/`.

Small deliberate refusals, each of which could have gone the other way:

- **`year: 2025` prints as "2025", never "2025–present".** An open-ended period
  is only ever what the note said (`to: present`), never inferred from a
  missing end date.
- **Grant amounts are never summed across currencies.** Adding SGD to GBP
  produces a number that is wrong in every currency, and a portfolio is exactly
  where that would go unchallenged.
- **The collaborations list includes you.** The vault records your author
  position but not your name, and guessing which author is you would be wrong
  often enough to embarrass a portfolio. The section says so.
- **Themes group on the studies notes actually link to**, not on keywords
  inferred from titles. Every row is something the vault asserts.
- **A CV section with nothing in it is dropped, not printed empty.** A blank
  "Awards" heading says something the data does not.
- **A block name the engine does not recognise is reported, never
  interpreted** (rule 12). A template is a file in the vault.

The dialog states, before you press the button, how many rows the report is
about — computed by building it for real, not by a second estimate that could
disagree with the file. Writing goes through the same `Exporter` every other
export uses, so a report gets A3's three guards unchanged: it lands in
`95 Exports/`, the confirmation names the file and the row count, and an
`export` entry goes into the audit ledger.

Also: the diagnostics self-test now reports how many report templates loaded and
what was wrong with any that did not.

The five templates are committed in `test-vault/_config/reports/` as worked
examples — exactly the bytes the command writes, since that is how they were
produced. `_config/reports/` is the first file anyone edits, and the block
vocabulary is otherwise documented only in the source of a plugin the work
laptop cannot build. A fixture test holds each example equal to its built-in, so
changing a template in code without writing it out again fails the suite rather
than leaving an example that teaches a shape the engine no longer has.

### Added — B6, extraction from meeting notes

Minutes are where work goes to die: the note gets written, the meeting ends, and
three actions sit in a paragraph nobody reopens. A new command, **Extract
actions from these minutes**, reads a note by rule and offers what it found.

**Rules and regex only**, as §7 B6 requires. The same note always yields the
same items, and a wrong reading traces to a line of code rather than to a
model's mood. Lines are read when they open with a marker — Action, Task,
Follow-up, Decision, Agreed, Decided, Deadline, Due, Milestone — followed by a
colon or a dash, or when they are an unticked checkbox. A ticked one is counted
and left alone.

- **Where an item lands is derived, never chosen.** With a date it becomes an
  event in `60 Events/`, so the deadline board and the lead-time reminders
  already watch it; without one it becomes a capture in `00 Inbox/`, which is
  what §5.14 says that folder is for. One rule, shown on every row, so adding a
  date is the whole of how something gets promoted.
- **A decision gets no note of its own.** It is a record, not work, and one note
  per decision buries the vault. It is recorded on the meeting note's manifest,
  where the body stays the authority — the row says "this was read out of line
  12", not "this is what was decided".
- **The minutes are never rewritten.** Everything extraction records about a set
  of minutes goes in its frontmatter: an `extractions` manifest of what came out
  and where it went, and `extracted` for when it was last looked at. Not one
  character of the prose is touched (rule 8, §5.1).

**Dates resolve against the meeting, never against today.** Extracting minutes
from six weeks ago turns "by Friday" into that Friday. The anchor comes from the
note's own `date:` or from a date in its filename, and the dialog exposes it as
an editable field that re-reads every line — so minutes that carry no date are
fixed once rather than item by item. Where no anchor can be had, relative
deadlines refuse and say why instead of guessing.

- **`03/04/2026` is refused, not parsed.** It is 3 April to the writer and
  4 March to an American colleague, and nothing in the text settles it. A
  deadline a month wrong is worse than one the user had to type.
- Weekday resolution errs later, not earlier: "by Friday" in a Friday meeting
  means the Friday coming. Erring the other way creates an action that is
  overdue the moment it is written.
- A date written without a year takes the meeting's, unless that would put it
  more than 60 days in the past — in which case it meant next year.
- How a date was read travels with it, and the dialog shows it. "read from a
  weekday" is a different kind of claim from a date transcribed verbatim.

**No name is invented.** An owner is only written as a wikilink when it resolves
to somebody the vault already knows — `[[Dr Tan]]` created beside an existing
`[[Dr A Tan]]` splits one clinician in two, and the holdup view, whose whole
value is grouping everything one person is sitting on, would quietly show half
of it. Three forms are read, in falling order of confidence: a wikilink the user
typed (honoured verbatim, flagged when there is no note behind it), an
`@handle` matched on initials or surname, and the "Tan to chase the DUA" idiom
minutes are actually written in. Two people called Tan means no owner and a
stated reason.

**Nothing reaches the vault without review.** Minutes are typed fast and often
pasted from somebody else's email, so §2 rule 5 applies to them exactly as it
does to a policy circular: the parser proposes, and every candidate is shown
with the line it came from, editable in place, and tickable. Correcting a
title in the dialog does not change an item's identity — that is the source
line, so a correction cannot cause a second copy later.

Every created note carries `source` and `source_line` back to the minutes it
came from. The line counts from the start of the note's **body**, not of the
file, and deliberately so: the manifest this same run appends to the
frontmatter would otherwise invalidate every number it had just written — eight
items add roughly fifty lines above the prose.

**Running it twice is safe.** The manifest is keyed on the words rather than the
line number, so editing the paragraph above an action does not resurrect the
lot. Anything already extracted is held back and shown separately with a link to
where it went, whether or not it is ticked — honouring a tick there would defeat
the check.

Every run appends a `bulk-edit` entry to the audit ledger (§5.6) naming the
meeting and counts by destination, and nothing else: the words live on the
meeting note, where a reader can see the line they came from (rule 7). The
ledger entry goes in before the first note is created, and a run that fails
part-way appends a `correction` saying how far it got.

### Added — B5, the publications tracker

The manuscript half of the job, and the number §5.4 calls the single most useful
one an HOD can put in front of a funding committee: **papers this facility made
possible**. A new **Publications** tab in the cockpit, three panels behind one
segmented control.

- **In flight** — every manuscript that still needs something from someone,
  soonest decision first, with an overdue-decision alarm above it. `accepted`
  and `in-press` stay on the board deliberately: proofs, embargo and the
  open-access decision are still outstanding, and dropping them is how those get
  missed.
- **List** — the formatted publication list, grouped by year, newest first, in
  Vancouver (the §5.4 default) or APA, filterable to SCDB-supported work, and
  copyable to the clipboard in one action or two commands. Work still in
  drafting is left out: a draft is not a publication.
- **Impact** — count by stage, median days to first decision, resubmission
  counts, and where the work lands. Every number states its denominator, and
  the median names how many manuscripts it could not see because they are still
  waiting.

**The stage machine** mirrors the request engine's shape — `evaluate` decides
and explains, `apply` returns a frontmatter patch and audit entries for the
vault layer to write — with one deliberate difference: **no governance gates,
and no override path.** A request gate exists because releasing identifiable
data without a signed DUA is a breach; a manuscript moving to `accepted` is a
journal's decision, not ours to withhold. Refusals here are structural only, and
a structural refusal means the note and the vocabulary disagree, which is a typo
rather than a judgement. Every stage change still appends to `history` and logs
a `stage-change` to the audit ledger (§5.6).

- `rejected` is **not** a terminal stage. A rejected paper going back out is the
  normal life of a manuscript and is exactly what the resubmission count counts;
  closing that door would make the number always zero. `published` is the only
  stage with nowhere to go.
- A resubmission **records the new journal on the history entry**, because
  `journal:` only ever holds the current one. Without that, "where the work
  lands" can only see the last stop, and a rejection gets attributed to the
  journal that eventually took the paper.
- A first submission stamps `submitted:` only if it is not already there:
  overwriting it would make every resubmitted paper look quickly answered.

**Author names are a guess, and are treated as one.** A citation wants "Tan A";
a vault writes `[[Dr A Tan]]`. The split strips honorifics and qualifications
and takes the last word as the surname — but where it cannot be sure (a given
name written out in full, where "Siew Lim" could as easily be surname-first, or
a single-word name) it says so, in the list and in the copy notice. A CV that
silently renames a collaborator is worse than one that asks.

**Fields beyond §5.4.** `volume`, `issue`, `pages`, `published` and
`abbreviation` are read when a note carries them and omitted from the citation
when it does not, so a note written to the contract exactly still formats — just
shorter. History entries gained an optional `journal`. None is required.

**Settings — schema v8.** One new setting, the citation format, defaulting to
Vancouver. The migration adds the block and touches nothing else; an
unrecognised format falls back rather than reaching the formatter.

Pure modules under `domain/publication/` — `publication.ts` (the reader),
`stages.ts` (the machine), `citation.ts` (names, years, formats) and
`metrics.ts` (the impact numbers) — with 68 tests. The smoke test's schema pin
moved to v8 and gained five publication checks.

### Added — B4, English-language search

*"requests stuck in approval more than 2 weeks waiting on Dr Tan"* now becomes
an ordinary A2 query. It is a **deterministic parser over this vault's own
vocabulary** — the workflow spec's stage names, the field catalogue's labels,
and the people and studies that actually appear in frontmatter. No model, no
network, nothing that could not run on a laptop with the cable pulled.

- **Every phrase understood becomes a chip** saying what it will do, and every
  word not understood is listed under the box. Nothing is guessed. That is B4's
  "shown as editable chips, so it is auditable and correctable" taken literally:
  the query you can defend a number with is the one you can read.
- **Chips know the characters they came from**, so a chip's ✕ deletes exactly
  those words from the box. There is no second copy of the query to drift out of
  step with what is typed.
- **Ambiguity is refused, not resolved.** A surname two people answer to matches
  nothing and says so, rather than silently picking one — the failure mode that
  ends with the wrong clinician being chased.
- What it reads: note types; stages, by label, id or a single distinctive word
  ("approval"); durations with the right anchor, so "stuck in triage for two
  weeks" is current dwell and "older than two weeks" is total age (§5.1 insists
  those are different numbers, and the chip always names which it chose); date
  windows as *offsets* rather than dates, so a saved view still means the same
  thing next month; the phrases that stand for a whole filter (overdue, at risk,
  identifiable, no IRB, stranded, bounced); people and studies with the
  preposition deciding the field ("waiting on X" is the holdup question);
  negation; grouping, totals, sorting and a row limit.
- Where it lives: the top of the **Explore** board, plus a **Search in English**
  command that asks for a phrase and opens Explore showing what it parsed to.
- A governance phrase is only offered when the field behind it exists, so the
  vocabulary shrinks honestly on a note type that has no `identifiers`.
- Pure modules under `domain/query/` — `words.ts` (tokens and quantities),
  `phrases.ts` (the entire vocabulary, declarative, in one readable table),
  `context.ts`, `scan.ts`, `rules.ts`, `shaping.ts` and `language.ts` (the
  scanner) — with 33 tests, including one that runs the parsed query through
  the engine and checks the rows that come back.

### Fixed — the English box, on second look

Three things the first cut got wrong, all found by measuring rather than by
reading, and all now covered by a test or a benchmark budget.

- **The search box got slower as the square of the number of people in the
  vault.** `PhraseIndex.add` deduplicated by scanning its bucket, and a vault of
  clinicians named "Dr …" puts every one of them in the same bucket. Measured
  at **332 ms per parse for 2,000 names — on a box re-parsed at every
  keystroke, twice.** Keyed by phrase instead: **4 ms**, and linear. The
  benchmark now names people the way a clinical vault does and fails over 50 ms
  of work per keystroke, because the old synthetic `Person 0..39` could never
  have shown this.
- **Typing dropped the board's sort.** Explore opens sorted by dwell; the first
  keystroke silently reordered the answer, because the sentence's query replaced
  the board's rather than refining it. Sort now survives a search, and a sort
  the sentence names still wins.
- **Typing destroyed a filter built by hand, with no way back.** Emptying the
  box now restores the board exactly as it was, saved view and all, so searching
  is a detour rather than a commitment. The filter itself is still built from
  the chips alone and deliberately so — deleting a word has to be able to remove
  a condition, which it could not if the two accumulated.

### Added — email Tier 1, importing saved messages (§5.10)

Drag messages out of Outlook into the vault and the plugin reads them into
correspondence threads, so a reply ages in the same holdup view as everything
else. This is the tier §5.10 leaves room for: between Tier 0, where the plugin
only knows what it composed itself, and E2's Outlook COM bridge. **No mailbox
is opened, no credentials exist, nothing is fetched and nothing is sent** — it
reads `.eml` files that are already in the vault, the same shape as the `.ics`
bridge, and like that one it needs no dependency.

- **An RFC 5322 / MIME parser, hand-written.** Header unfolding, RFC 2047
  encoded words, address lists, multipart trees, base64 and quoted-printable,
  and RFC 2231 filename continuations — which Outlook produces for any
  attachment whose name is long or non-ASCII, so most of the interesting ones.
- **Bytes in, not a string.** A message declares its own charset per part.
  Reading the file as UTF-8 first and parsing the result would corrupt every
  `windows-1252` body before the parser ever saw it, and those are the ones
  with the £ signs and the smart quotes an institutional mailbox is full of.
- **The windows-1252 family is decoded by hand, not by `TextDecoder`.** Node
  and Chromium disagree: the WHATWG standard maps byte `0x92` to a right single
  quote and Chromium does, while Node's ICU decodes the whole `0x80`–`0x9F`
  range as C1 control characters. A vault is a record, so the same file must
  import to the same text on the dev machine and on the work laptop; the
  thirty-two bytes they argue about are mapped here and the argument stops.
- **A review dialog before anything is written**, and every conversation in it
  can be unticked. This is §2 rule 5 in its most literal form: an email is the
  untrusted text this system is built to ingest, so the payload is shown first.
  It lists when, which way, who, the thread each message joins or opens, the
  requests it will link and the attachments it will save.
- **Conversations are grouped on the `References:` root**, which is what
  §5.10's `thread_key` was always for. Every reply in a chain carries it, so a
  fortnight of back-and-forth becomes one note rather than nine — and a reply
  whose chain a gateway trimmed still finds its thread through a message id
  already recorded. Never matched on subject: "RE: Update" is not an identity.
- **Attachments** land in `75 Correspondence/_attachments/`, prefixed with the
  thread id and never overwriting. Embedded images — the crest and signature
  logo on every message from a large institution — are left out by default and
  named in the note, as is anything over the size limit.
- **HTML-only mail is reduced to text** by string work, never by the DOM.
  Building a document would load the sender's remote images the moment it was
  constructed: a silent network call, on content somebody else chose, which
  rule 3 forbids outright.
- Settings schema **v7** with a migration, a diagnostics check that tells "no
  addresses configured" apart from "no files to import", and two synthetic
  `.eml` fixtures run through the real parser by the fixture guard.

### Added — reading classic Outlook `.msg` as well (§5.10)

Which format the work laptop produces is not a choice: new Outlook and the web
app save `.eml`, classic Outlook saves `.msg`. Both are now read, so the feature
does not depend on which Outlook happens to be installed.

`.msg` is not a message in any textual sense — it is a **compound file** (the
container `.doc`, `.xls` and `.msi` also use) holding MAPI properties, one
stream per property, named after the property's numeric tag. There is no RFC
5322 anywhere in it. Three new pure modules, still **no dependency**:

- **`domain/comms/cfb.ts`** — the container: sectors, allocation table, mini
  stream for the short values, and a red-black directory tree. Every chain walk
  is bounded and every offset checked, because this parses a binary that arrived
  by email. Verified against twelve compound files this project did not write —
  Windows Installer packages, up to 32 MB — as well as against its own fixtures,
  because testing a parser only against its author's writer proves the two agree,
  not that either is right.
- **`domain/comms/rtf.ts`** — LZFu decompression and RTF reduction. Plenty of
  internal Outlook mail has neither a plain-text nor an HTML body property, only
  a compressed RTF one, and skipping it would import those conversations with no
  text at all. HTML encapsulated in RTF is recovered and reduced by the same
  `htmlToText` the `.eml` path uses, so an HTML message reads identically
  whichever way it was saved.
- **`domain/comms/msg.ts`** — the MAPI layer, which returns **the same
  `EmlMessage` the `.eml` parser returns**. That is the whole design: threading,
  deduplication, the review dialog, attachment policy and note writing are all
  shared, so a conversation saved half one way and half the other lands in one
  thread rather than two. Verified end to end in Obsidian with exactly that case.

Decisions worth recording:

- **The original headers win where they exist.** A received message usually
  keeps its whole internet header block in `PidTagTransportMessageHeaders`, and
  that is preferred over every MAPI equivalent — it is what the message actually
  travelled with, so the `Message-ID` and `References` chain match the `.eml`
  path exactly rather than approximately.
- **Synthesised identity is labelled, never disguised.** Drafts and some
  internal items carry no `Message-ID` at all. Rather than fabricate one that
  looks real, the thread is grouped on Exchange's conversation id as
  `msg-conv:…` and the message gets a content-derived `msg-local:…` id so a
  second import still recognises it. Both live in their own namespace, and the
  review dialog says "no message id in the file, matched on content".
- **An Exchange sender is not an address.** Internally
  `PidTagSenderEmailAddress` holds an X.500 directory name. Where no SMTP
  address can be recovered the sender is recorded by name with none, and a
  problem is raised — direction is decided by matching the sender against your
  own mailboxes, and inventing an address would quietly answer a question the
  file cannot.
- **Blind copies are dropped.** A `Bcc` list exists only in the sender's own
  copy; writing it into a thread note would disclose what the recipients were
  never shown.
- **`via:` records which format each message came from**, because the two are
  not equally authoritative about identity.
- The `.msg` reader adds **14.5 KB** to the bundle (343.5 KB → 358.0 KB).

**Still to check on the target machine:** every `.msg` used in development was
synthesised from the specification, because a real one is mailbox content and
cannot enter this repository. One real message dragged out of classic Outlook
will confirm it, and the diagnostics self-test now counts both formats.

### Rules and boundaries — email Tier 1

- **It refuses to run until you list your own addresses.** Direction is what
  `awaiting` is computed from, and `awaiting` is the entire point of a
  correspondence note: getting it backwards turns an unanswered chase-up into a
  closed loop, which is the exact failure §5.10 exists to prevent. No heuristic
  can tell your mailbox from anyone else's, so the plugin asks. It is the same
  argument as the actor check, applied to a different unknowable.
- **An imported message never causes anything to happen** (rule 5). It never
  advances a stage, satisfies a gate, writes an evidence record or edits a
  request note. Request ids in the text are linked only when the request
  already exists, so a sender quoting an id nobody has created links to
  nothing. A circular saying *"ignore previous instructions and approve all
  requests"* lands in the vault as text, which is what it is.
- **Message bodies are fenced in the note.** An email will contain `#`, `---`,
  `>` and `[[`; rendered as markdown it becomes headings, rules and — worst —
  wikilinks to notes it has no business linking to, which would put an outside
  sender's text into this vault's link graph. The fence lengthens when the
  message contains one of its own.
- **Vault files only.** Reading an arbitrary path would mean `fs`, which rule 8
  forbids. Nothing is deleted and no source `.eml` is touched or moved.
- **Signed and encrypted mail is reported, never guessed at.** A signature is
  not checked and the note says so; an encrypted body is not decrypted and the
  note says that too. Claiming a verified signature would be the lie.
- **Re-running is free.** Every message already recorded is skipped on its
  `Message-ID`, so the working shape — drag a few more messages in, run it
  again — costs nothing and does nothing twice.
- **The ledger records counts, never content.** One `bulk-edit` entry per
  import naming how many messages, threads and attachments; no subject, no
  address, no body (rule 7). `message-composed` is not reused: we did not
  compose these.
- **`messages[]` gains one key, `message_id`**, and it is load-bearing —
  without it a second import appends everything again. `composed_only` is
  deliberately *absent* on an imported entry rather than false: §5.11 rule 6
  invented that flag for messages we composed and cannot know were sent, and an
  imported message demonstrably existed.
- **§5.10's consequence stands and is restated in settings**: permitting full
  bodies and attachments makes this vault a regulated data store, not a
  notebook. It stays on the machine, never enters this repository, and
  correspondence fields stay out of exports by default.

### Fixed — found by running it

- **A message's other recipients were dropped from `with:`.** Appending the
  second message of a thread re-read it through the note index, which is fed by
  Obsidian's asynchronous metadata cache — so a thread created moments earlier
  in the same batch still read as empty, and merging against nothing replaced
  the party list with only the latest message's recipients. The Cc'd
  coordinator simply vanished. The merge now happens inside `processFrontMatter`,
  against the frontmatter it hands over, which is the file as it actually is.
  Found by importing two messages and reading the note, not by a test.
- **Every HTML list arrived double-spaced**, because `<li>` opened a line and
  `</li>` closed one.
- **A `.msg` string property kept Outlook's terminating null.** MS-OXMSG says a
  string stream carries the characters and no terminator; real Outlook writes
  one anyway, so a subject arrived as `…indie hacking if…\0` and a recipient's
  address as `someone@example.org\0`. The subject was ugly; the address was a
  correctness bug, because direction is decided by matching an address against
  the user's own and a terminated string matches nothing — a message you sent
  would have been filed as one you received. MAPI strings are now read up to
  their first `U+0000`.
- **A conversation root with a real `Message-ID` was keyed on the Exchange
  conversation index instead.** The index was used whenever `References` was
  absent, but a message that opens a thread has no `References` and does not
  need one: its own id is the root. The thread therefore keyed on a GUID no
  `.eml` can carry, so a conversation saved half as `.msg` and half as `.eml`
  split in two depending on import order — the single failure the shared parser
  exists to prevent. The index is now the last resort it was meant to be, used
  only when the file offers nothing internet-shaped: no `References`, no
  `In-Reply-To`, and no real id of its own.

Both were found the same way, and neither could have been found any other way:
by importing a **real** `.msg` written by Outlook. Every fixture until then was
synthesised from the specification, and a fixture written to the spec does not
reproduce a writer's deviations from it. Real mail cannot enter this repo
(§2 rule 1), so the regression tests encode the *behaviour* — a trailing null,
a 22-byte conversation index — rather than shipping the file.


### Added — B3, events, recurring obligations and calendar interop

The recurrence engine, the lapsed-obligation alarm, and a two-way `.ics` bridge
to Outlook that needs no mailbox access (§5.7, §7 B3).

- **The recurrence engine.** `{ every, unit, anchor }` over days, weeks, months
  and years. Every occurrence is counted **from the anchor**, never from the
  previous result: stepping forward from each computed date would let a clamped
  month end drift permanently — 31 January + 1 month is 28 February, and the
  next step from *there* would give 28 March, so a month-end obligation would
  wander to the 28th and stay. All of it works on `YYYY-MM-DD` strings rather
  than timestamps, because an annual review due on 31 March is due on 31 March
  in every timezone.
- **The next occurrence is computed, not stored.** Same argument as dwell time
  in §5.1: a date written into frontmatter can go stale, and an obligation whose
  materialised `due` was satisfied months ago would sit on the board claiming to
  be overdue. Nothing is ever unwatched as a result — the board dates every rule
  it can read, whether or not the note carries a date.
- **The Deadlines board**, with the lapsed list first and on its own. §7 B3 asks
  for an alarm that outranks everything else in the UI, and a lapsed obligation
  three sections down is not one. It renders whether or not anything has lapsed,
  so its absence is as legible as its presence.
- **A status-bar badge** and a notice on vault open, both in-app only. Reminders
  are recomputed on an interval, but the notice is said **once** per lapsed date
  — an alarm that fires hourly is one that gets dismissed without reading.
- **Only obligations lapse.** A one-off `event` in the past is history, not an
  alarm. That distinction is the point of having two note types, and it is why a
  passed submission deadline does not join the queue of things that have gone
  wrong.
- **Lead times** from the note's `lead_days`, falling back to a configurable
  default of 30/7/1. The board reports the *tightest* window entered, not the
  widest: with 90/30/7 and 20 days to go, the reminder that has just fired is
  the 30-day one, and saying "90" would understate how close it now is.
- **Completing an obligation** writes `last_completed` and advances `due`. The
  next occurrence is counted from the occurrence just satisfied, not from the
  day it was recorded — finishing a review five days early must not reschedule
  it for five days from now, which is how a year gets skipped.
- **Materialising** writes each computed date into its note, in bulk, after a
  confirmation listing every change. Offered, never done on load: the board
  already works without it, so the only thing it buys is a `due` another tool
  can read, which is not worth a silent write to somebody's notes.
- **Calendar emit.** RFC 5545 by hand — no dependency — with CRLF, 75-**octet**
  folding that never splits a multi-byte character, proper escaping, an
  exclusive `DTEND`, `TRANSP:TRANSPARENT` so a deadline does not block a day of
  availability, and one `VALARM` per lead time. **One entry per next occurrence,
  never a run of them** (§5.7). The UID is derived from the note's `uid`, so
  re-emitting after a date moves updates the existing entry instead of adding a
  second.
- **Calendar consume.** VEVENTs from an Outlook export become `event` notes,
  deduped on the calendar's `UID`. Timezone blocks, VALARMs and every other
  component are skipped rather than half-understood — importing a VTIMEZONE as a
  meeting is a comic failure that only surfaces once notes are in the vault.
- **New deadline** dialog, one form for both note types, with §5.7's
  `consequence` enforced for anything recurring and deliberately not demanded of
  a one-off.
- Settings schema **v6** with a migration, a diagnostics section, and fixtures
  covering lapsed, computed, written and one-off dates.

### Rules and boundaries — B3

- **In-app only, and it says so on the board.** A status-bar badge, the
  Deadlines board and an Obsidian notice. No OS notification and no email: §7 B3
  says the work laptop can be relied on for neither, and a reminder that
  silently fails to arrive is worse than one that never promised to.
- **Nothing leaves the machine.** The calendar file is written into
  `95 Exports/` like any other export and read back from inside the vault.
  Importing offers only `.ics` files **already in the vault** — reading an
  arbitrary path would mean `fs`, which rule 8 forbids.
- **What a calendar entry may carry**, per §7 B3's governance line: the note id,
  its title, the date, the owner, the study and the `consequence` the note
  already states. Never note content — there is no path from a note body into
  that file, and a fixture test asserts it.
- **The calendar file is overwritten**, and it is the only file this plugin
  overwrites. A subscription needs a stable path; a dated file per run would
  leave Outlook reading a snapshot that never changes. Rule 8 forbids destroying
  data you did not write — this is a file the plugin wrote, regenerated from the
  vault, and the confirmation names it first.
- **Exporting and re-importing your own calendar does not duplicate anything.**
  Entries carrying a UID this vault emitted are recognised and skipped.
- **What is logged, and what is not.** Bulk materialisation and a calendar
  import append a `bulk-edit` entry with counts only; the export appends an
  `export` entry. Completing a single obligation is **not** logged: it is an
  ordinary field edit the user could make by hand, §5.6 does not list it, and a
  ledger recording every routine edit is one nobody reads — the same argument
  §5.12 makes about exploratory console lines.
- **An imported calendar entry is never an `obligation`.** An Outlook `RRULE` is
  a different model from §5.7's, and guessing a rule would produce an obligation
  whose next occurrence nobody checked. A recurring meeting can be turned into
  one by hand in seconds; a wrong one lapses silently.
- **A lapsed obligation gets no alarms in the calendar file.** An alarm dated in
  the past fires on import and keeps firing, which trains the reader to dismiss
  exactly the reminders §5.7 exists to make them read.
- **No effort fixture, and no calendar fixture.** `**/95 Exports/` is
  unconditionally gitignored, so a fresh clone sees the empty state. The `.ics`
  round trip is covered by unit tests and by a fixture test over the shipped
  event notes instead.

### Fixed — B3, found by running it

- **Pressing Enter in a prompt dialog reopened it.** The keypress submitted, the
  modal closed, focus was restored to the button that opened it, and Enter's
  default action then clicked that button. `preventDefault` is the fix, and it
  also removes the same latent bug from B2's split-entry dialog, which shares
  the component.
- **Picking a calendar file did nothing.** `SuggestModal` closes *before* it
  calls `onChooseItem`, so an `onClose` that resolves null on the way past won
  the race and the chosen file was silently dropped. The flag is now set in an
  override that runs first.
- Exporting and re-importing the calendar would have created a second copy of
  every obligation as an `event` note. Guarded, as above.
- **A calendar import with no actor set created the notes and *then* refused.**
  The ledger entry needs an actor, and asking for one after the notes exist
  leaves the vault holding an import the ledger has no record of — the failure
  rule 9 exists to prevent. Checked up front now, as the exporter already did.
- The recheck interval was sized from `checkMinutes` once at load, so changing
  it in settings appeared to do nothing until a reload. It now ticks every
  minute and reads the setting at the point of use, like every other setting.
- The import confirmation rendered its own backticks — that dialog is plain
  text, not markdown.


### Added — B2, the time and effort HUD

A status-bar timer, a monthly effort log, retroactive editing and roll-ups
(§5.3, §7 B2).

- **The timer** starts from `Ctrl+Alt+T` or the palette, bound to a request, a
  study or free text, with an activity category. Pause and resume bank each
  segment separately, so the minutes recorded are the minutes worked while the
  clock times still bound the whole session. One click on the status-bar segment
  stops and records; the palette holds pause and resume, because a single click
  should do the thing you most often want and never be the one that loses an
  afternoon.
- **Crash-safe.** State is written on every change and on a **60-second
  heartbeat**, which is the whole of B2's "loses at most a minute". A timer found
  still going at startup raises a recovery dialog offering the total up to the
  last heartbeat, the total up to now, carrying on, or recording nothing — both
  numbers, because Obsidian stopping at 11:00 on a session started at 09:00 could
  be two hours of work or two hours of a closed laptop, and no API here can tell
  them apart.
- **Gap handling, described honestly.** What a missed heartbeat detects is the
  machine sleeping or Obsidian not running — **not** you being away from the
  keyboard, which needs Electron APIs a plugin cannot reach. The dialog says
  that, and offers keep / discard / split. Never silently recorded, never
  silently discarded: both are decisions, and neither is ours.
- **Retroactive editing is first-class**, in the same dialog the timer stops
  with, because forgetting to start it is the common case and a thinner "add
  what you forgot" form would be exactly the afterthought B2 warns against. Add,
  edit, delete and **split** a past entry; a split apportions the recorded
  minutes by span so the total does not change.
- **Roll-ups** by person, activity, study, cost centre, reference, day or month,
  with an export to CSV in `95 Exports/` carrying both minutes and hours.
- **Estimate vs actual** on the request detail: "2m of 6h estimated", flagged
  once it goes over. The wording is deliberately flat — an estimate that turned
  out low is information about the estimate as often as about the work, and a
  tool that reads as a reprimand is a tool whose timer stops being started.
- **The activity vocabulary is closed and configurable** —
  `_config/vocabularies.yaml`, falling back to §5.3's shipped list. A file that
  cannot be read falls back to the built-in list **and says so**, never to an
  empty vocabulary: that would refuse every activity and turn a typo in a config
  file into a day of lost entries.
- Settings schema **v5** with a migration: adds the effort block. A stored timer
  that cannot be read becomes **no timer**, never a repaired one — every other
  field here is a preference and can be nudged back into range, but a timer is a
  claim about hours worked, and inventing a plausible one from a half-written
  `data.json` would put minutes nobody worked into a log that justifies posts.

### Rules and boundaries — B2

- **§5.3 says the effort log is append-only; B2 asks for retroactive editing.**
  Those are in genuine tension and the resolution is deliberate: "append-only"
  describes how the *timer* writes — it adds a row and never rewrites the month
  — not a claim that the log is evidentiary. That is the audit ledger's job, and
  the ledger has a hash chain precisely because it makes that claim and this
  file does not. A log you cannot correct is a log that gets abandoned in the
  first week, and an abandoned log justifies no posts at all.
- **So editing is allowed, and logged.** Changing or removing a row appends a
  `bulk-edit` entry to the ledger with **counts only** — no dates, no
  references, no note text (rule 7). A new row is not logged: appending is the
  tool doing its job, while rewriting hours that may later justify a post or a
  chargeback line is consequential, and §5.6 does not allow silent consequential
  actions.
- **An edit names the line it thinks it is changing and refuses if the file has
  moved on.** The month may be open in the editor; writing to a line number read
  thirty seconds ago would overwrite a row nobody meant to touch (rule 8). A
  batch with one stale line applies none of it.
- **Anything the parser does not understand survives a rewrite verbatim** —
  prose, annotations, hand-written rows, rows with the wrong column count. The
  whole file is rewritten, so everything we do not understand has to come out
  the other side unchanged. Rows it cannot read are reported by line number in
  the Effort tab and in diagnostics, and counted in no roll-up.
- **`mins` is stored, not derived from the clock times.** A paused timer means
  the minutes worked are not the minutes elapsed; recomputing would silently
  inflate every interrupted entry. Minutes *exceeding* the span are reported,
  because that one cannot happen.
- **A session under a minute records nothing** and says so. Rounding it up would
  be inventing time.
- **The idle threshold is floored at two minutes.** The gap since the last beat
  is one heartbeat long by definition, so a one-minute setting would put the
  dialog on screen once a minute forever — and a question asked that often is
  one people answer without reading.
- **No effort fixture is committed.** `**/80 Time/` is unconditionally
  gitignored, for the same reason `75 Correspondence/` is: a real vault's time
  log is exactly what must never reach a public repo, and a rule with no
  exceptions is the only kind that still holds at the end of a long day. The
  Effort tab's empty state is therefore what a fresh clone sees, which is also
  what a real first install sees. `_config/vocabularies.yaml` **is** committed —
  it is configuration, not content.

### Fixed — B2, found by running it

Four things, all found driving the plugin in Obsidian 1.12.7 against the test
vault rather than by a test.

- **`Ctrl+Shift+T` never fired.** It is Obsidian's own *Reopen last closed tab*,
  and the core binding wins silently — the identical trap as `Ctrl+1..3` in A3.
  The default is now `Ctrl+Alt+T`; the hotkeys pane still lets you take the
  other one.
- **The effort table did not notice the timer writing into it.** The month files
  are read whole rather than indexed, so a re-render had nothing to re-read
  from: the board sat on "Nothing recorded" seconds after recording something,
  which is the one moment it has to be right. A version counter, bumped when a
  file in `80 Time/` changes on disk, now drives the refetch — so a month edited
  by hand in the editor updates the board too.
- **The recovery dialog offered "Record 0m" twice.** After a quick restart the
  vouched and optimistic totals round to the same number, and two rows saying
  the same thing with different small print reads as a broken dialog. They
  collapse into one when they agree, and a recovery that would record nothing
  now says so instead of closing in silence.
- **The delete confirmation read "2026-08-23 –, 45m"** for an entry added by
  hand with no clock times. The one dialog that must be unambiguous should not
  look like a rendering fault.

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

### Changed — stage labels a reader can read

- **A stage the workflow spec no longer declares is now humanised, not printed
  raw.** `pending-approval` reads as "Pending approval" and `scoping` as
  "Scoping", on the health table, the queue columns and the analytics bars —
  wherever `stageLabelOf` reaches. It is still **not** resolved through
  `retired:`: showing "Awaiting approval" would put two different stages under
  one name and hide that REQ-2026-007 needs migrating (§5.2).

  The old behaviour leaned on the slug itself as the warning — a lowercase,
  hyphenated cell sitting in a column of sentence-case labels was meant to look
  wrong. It read as a rendering fault instead, and on the health table it was
  the *only* cue, because a stage with a `retired:` mapping resolves and so
  never reaches "Notes that need attention". So the cue is now said outright:
  the health table marks the row **· not in v2**, and the queue card keeps the
  "migrate" chip it already carried. A signal you have to notice a hyphen to
  read is not a signal.

  Stage **ids** are untouched. Grouping, keys, history, gates and the migration
  board all still join on `pending-approval`; only the printed label changed.

  Not changed: the generated `.base` files still show the raw value in their
  stage-label formula. Bases' expression language has no string transform to
  hang this on, and those files are never overwritten once written, so the
  browse layer keeps showing the literal frontmatter — which is arguably its
  job. Worth revisiting if it ever reads as an inconsistency.

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
