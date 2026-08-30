# SCDB Cockpit

An Obsidian plugin for running a clinical data collection facility: data-request
tracking with governance gates, effort measurement, publications, and the audit
trail behind all of it. Offline-first, no telemetry, no network calls by default.

**Status: phase B3.** Track A is complete: request tracking end to end (A1),
the query engine behind the Explore board (A2), core Bases layered on where it
exists (A2b), the cockpit and its analytics (A3), and encrypted backup with
restore, verification, a diagnostics self-test and an integrity check (A4).
B1 adds the daily rhythm — quick capture, a daily briefing, meeting agendas,
the chase-up composer and outreach ageing. B2 adds the time and effort HUD — a
crash-safe status-bar timer, the monthly effort log, retroactive editing, and
roll-ups per person, activity, study and cost centre. B3 adds deadlines and
recurring obligations — a recurrence engine, the lapsed-obligation alarm, and a
two-way calendar bridge to Outlook that needs no mailbox access, and reading
saved `.eml` messages into correspondence threads. Bases is never a dependency:
on an Obsidian without it, every view still works. Not yet released.

The design lives in [CLAUDE.md](CLAUDE.md) — architecture, the vault contract,
build phases, and the rules that constrain them.

## Develop

```bash
npm install
npm test          # Vitest: the pure domain layer, plus the test-vault fixture guard
npm run dev       # watch build into test-vault/
npm run build     # typecheck + production build into dist/
npm run smoke     # load the built bundle against a stubbed Obsidian
npm run bench     # index + query timings over a synthetic 5,000-note vault
npm run package   # build + smoke + release zip for transfer
```

Open `test-vault/` as a vault in Obsidian and enable the plugin under
Settings → Community plugins.

## Install on another machine

There is no BRAT or community-store listing. Take `dist/scdb-cockpit-<version>.zip`,
and copy the `scdb-cockpit` folder from it into:

```
<vault>/.obsidian/plugins/scdb-cockpit/
```

Restart Obsidian and enable the plugin. The three files it contains —
`main.js`, `manifest.json`, `styles.css` — are the whole plugin; it downloads
nothing at runtime.

## The daily rhythm

Five things that share one query engine.

**Quick capture** (`Ctrl+Shift+C`) takes one line into `00 Inbox/` and records
which hat you were wearing. It asks nothing else, on purpose: every field it
could usefully ask for turns a two-second capture into a ten-second decision.

**Write today's briefing** produces a dated note — what could not be read, what
is due today, what is against target, what is stuck and with whom, what outreach
is unanswered, which decisions are awaited, what is coming up. Turn on
*Daily briefing → write one on the first open each day* in settings to have it
appear by itself. It never overwrites one that already exists.

**Build a meeting agenda for someone** joins everything one person is holding
up — requests awaiting them, manuscripts awaiting their review, obligations they
own, outreach they have not answered — into one list, urgent first, with how
long each has been waiting. Copy it as markdown for the minutes, or turn it into
a message.

### Composing a message

**The plugin composes; it never sends.** There are no credentials, no mailbox
access and no app registration. It builds a `mailto:` or Teams link, hands it to
Windows, and your mail client opens a draft that *you* press send on. The
clipboard is an equal option, not just a fallback — it is the path that works
when nothing is registered.

Three guards worth knowing about, because they will occasionally refuse
something:

- **An address containing a line break, comma or quote is rejected, not
  escaped.** A CR or LF in a `mailto:` recipient adds extra headers —
  `a@b.com` + a newline + `bcc:…` silently blind-copies a message about a data
  request — so an address we cannot vouch for stops the draft and gets named.
  Recipients come from notes, and notes get pasted out of email.
- **A long draft goes to the clipboard whole rather than opening truncated.**
  Handlers cut somewhere around 2,000 characters and the exact figure varies by
  machine; the ceiling is a setting and the message tells you both numbers.
- **Templates can only reach a closed set of fields.** `_config/messages/chase-up.md`
  sets your tone and signature, and may use `{{name}}`, `{{date}}`, `{{count}}`,
  `{{summary}}`, `{{items}}` and `{{actor}}`. There is deliberately nothing that
  reaches note prose, because a protocol URI passes through the OS shell and can
  surface in system logs.

Settings has **Test mailto:** and **Test Teams** buttons. They open a throwaway
draft addressed to a reserved example domain so you can see, on the machine that
matters, whether anything is registered to handle them.

### Outreach ageing

Every message you compose opens or updates a thread note in `75 Correspondence/`.
Because the plugin composed it, it knows the date — so unanswered outreach ages
into the **same** holdup board as blocked requests, grouped by the same person:
*"Dr Tan owes a signature, and hasn't replied to the email asking for it"* is one
conversation, not two screens. One click marks a thread answered.

Every message is recorded as **composed, not sent** — `composed_only: true` in
the note, `message-composed` in the audit ledger. We handed a draft to a handler;
you may have closed it. An audit trail that claimed otherwise would be worse than
none.

### Reading saved email

Drag messages out of Outlook into the vault, run **Import saved email files**,
and they become correspondence threads — so a reply that arrived ages in the
same holdup view as everything else, without the plugin ever touching your
mailbox. No credentials, no API, no app registration. It reads `.eml` files that
are already in the vault; a file goes in, notes come out.

**Set your own email addresses in settings first.** The import refuses until you
do, and that is deliberate: which way a message went is what decides whether a
thread is waiting on you or on them, no heuristic can tell your mailbox from
anyone else's, and getting it backwards silently closes a follow-up that is
still open.

Everything it will do is shown before it does any of it, and each conversation
can be unticked:

- Replies are grouped into **one thread** by their `References` chain, not by
  subject line, so a fortnight of back-and-forth is one note.
- A request id in the text is linked **only if that request already exists**. An
  imported message never advances a stage, satisfies a gate or edits a request —
  an email is untrusted text, and here it stays text.
- The message body goes into the note fenced, so a `[[wikilink]]` a sender wrote
  does not join your graph.
- Attachments go to `75 Correspondence/_attachments/`. Images embedded in the
  message — the crest on every institutional signature — are left out by default
  and named in the note instead, as is anything over the size limit.
- Running it again is free: messages already recorded are skipped on their
  `Message-ID`. Drop new files in and re-run.

**Either Outlook works.** New Outlook and the web app hand you `.eml` when you
drag a message out; classic Outlook gives `.msg`, a completely different
format — a compound binary of MAPI properties with no email headers in it at
all. Both are read, and the parser is chosen by looking at the file rather than
its extension, so a message renamed along the way still works.

Two things are weaker for `.msg`, and the review dialog says so per message:

- Where Outlook kept the original internet headers — which it does for anything
  that arrived from outside — threading is identical to `.eml`, and a
  conversation saved half one way and half the other lands in **one** thread.
- Where it did not (drafts, some internal Exchange mail), there is no
  `Message-ID` to work from. The thread is grouped on Exchange's conversation
  id, and each message gets an id derived from its own contents so re-importing
  still recognises it. Those are marked `msg-local:` rather than dressed up as
  real message ids.

One consequence worth stating plainly, because §5.10 of the design does: keeping
full message bodies and attachments makes the vault a **regulated data store**,
not a notebook. It stays on the machine, and correspondence fields stay out of
exports by default.

### Reading Outlook directly

If dragging files about is the tedious part, **Read new mail from Outlook**
skips it: the plugin reads the Outlook you already have open and offers you the
messages, in exactly the same review dialog, feeding exactly the same threads.
Off until you switch it on in settings, and it never runs on its own.

Still no credentials, no API, no app registration and nothing over a network —
it talks to the copy of Outlook running on this machine, through the automation
interface Outlook has always had.

Four things it will not do, and none of them are a matter of intention:

- **It never starts Outlook.** It attaches to a session that is already open,
  and says "Outlook is not running" when there is not one. A sync that launches
  your mail client is a surprise, and this plugin does not do surprises.
- **It never sends, moves, deletes or marks anything as read.** Nothing in the
  mailbox changes. A test reads the reader's own source and fails if a method
  that would change something ever appears in it.
- **It cannot freeze Obsidian.** Outlook can stop answering for minutes when it
  is sitting behind a dialog nobody has noticed, so the reader is a separate
  process on a deadline. When it runs out of time it is killed and you are told
  to go and clear whatever Outlook is asking.
- **It reads no attachments.** They are named in the note and left in the
  mailbox. When you need the file itself, drag that message into the vault and
  the import above saves it properly.

**It needs classic Outlook.** New Outlook and the web app expose no automation
at all, so on a machine with only those this is not available — use the drag-in
import instead. Settings has a **Check Outlook** button that answers this in one
press: it asks Outlook its version and nothing else, opening no folder and
reading no message.

**If your machine is monitored, this will be noticed — and that is answerable.**
Starting PowerShell from Obsidian with a base64 argument is a shape endpoint
monitoring is built to look at. Settings has **Show what runs**: both scripts in
full, the command line and every parameter, copyable, and reachable whether or
not the reader is switched on. The scripts are constants, so the plaintext
matches the encoded argument in the alert character for character — decode it and
compare. [docs/outlook-reader.md](docs/outlook-reader.md) is the covering page to
hand to whoever asks.

A message read this way and the same message dragged in as a `.msg` land in
**one** thread, not two. They derive identity the same way, on purpose, because
two implementations of a thread key would be two threads.

Every read is written to the audit ledger as `mailbox-read` — counts and folder
names, timing and Outlook's build number, never a subject or an address —
**including a read that finds nothing**. A sync that looked and found nothing
new still looked, and the ledger answers "when did this plugin last read my
mail".

**On the first run, set the window short.** The default reaches back a
fortnight, and on a first run every thread is new — so a fortnight of
institutional email arrives at once. Start at a day or two, see what the review
dialog offers, and widen it when you are happy with what comes through.

**This has not been run against a real mailbox yet.** It is built and its
refusals are tested, but the dev machine has no Outlook session to read, so the
read path is unverified. Expect to find something the first time; the failure
messages and the ledger row are written to be repeatable back to someone who
cannot see your screen.

## Time and effort

`Ctrl+Alt+T` starts a timer bound to a request, a study, or whatever you are
actually doing. It lives in the status bar; one click stops it and shows the
entry before it is written, so the activity and the note get fixed while the
session is still in mind. Pause and resume bank each stretch separately — the
minutes recorded are the minutes worked, not the minutes between the clock
times, which is why the log stores all three.

Entries land in one markdown table per month in `80 Time/`, readable and
diffable with the plugin uninstalled:

```
| date       | start | end   | mins | person | ref          | activity | study     | cost_centre | note |
| 2026-07-14 | 09:12 | 10:05 |   38 | yh     | REQ-2026-014 | scoping  | EuroHeart | RC-2026-07  |      |
```

The **Effort** tab rolls them up by person, activity, study, cost centre,
reference, day or month, and exports the roll-up to CSV. A request's detail shows
its time against `effort_estimate_hours`.

Three things worth knowing:

- **Everyone forgets to stop a timer**, so fixing it afterwards is a first-class
  feature rather than an apology. Add, edit, delete or split any past entry, in
  the same dialog the timer stops with. A split shares the recorded minutes
  between the halves in proportion, so the total never changes.
- **A crash costs at most a minute.** The timer writes itself down every sixty
  seconds. If Obsidian stops while one is running, the next start asks what to
  do with it and offers both totals — up to the last check-in, or the whole span
  — because only you know which is true.
- **A gap is a question, never an assumption.** If the machine sleeps or Obsidian
  is closed mid-session, you are asked to keep, drop or split the gap. Note the
  honest limit: what that detects is a missed check-in, not you being away from
  the keyboard, which no API available here can see.

The activity list is a closed vocabulary — free text gives you "extraction",
"Extraction" and "pulling data" as three categories and a roll-up that says
nothing. Edit `_config/vocabularies.yaml` to use your own; a file that cannot be
read falls back to the built-in list and tells you so in settings.

## Deadlines and recurring obligations

A note in `60 Events/` with a `due` date is watched. Add a `recurrence` rule and
it becomes an obligation that comes back:

```yaml
type: obligation
title: DSRB continuing review
recurrence: { every: 1, unit: year, anchor: 2026-03-31 }
lead_days: [90, 30, 7]
consequence: Study suspended if the review lapses.
last_completed: 2026-03-18
```

`consequence` is required, because a reminder that does not say what breaks gets
ignored. The **Deadlines** tab in the cockpit shows what has lapsed, what is due
now, and what is coming up; **Done** records a completion and moves the date on.

Three things worth knowing about how it counts:

- **The next date is worked out, not stored.** A note carrying only a rule is
  still watched — the board dates it and marks that date *computed*. **Materialise**
  writes those dates into the notes when you want them there, after showing you
  every change; nothing is written on load.
- **Occurrences are counted from the anchor.** A review anchored to 31 January
  lands on 28 February and then back on 31 March, rather than drifting to the
  28th and staying there.
- **Completing early does not move the cycle.** Finishing a review five days
  ahead of its date schedules the next one a year after *the date*, not a year
  after the day you happened to record it.

Only obligations lapse. A one-off event that has passed is history, and the
alarm stays for the things that have actually gone wrong.

### The calendar bridge

**Write deadlines to a calendar file** produces an RFC 5545 `.ics` in
`95 Exports/`, replaced each time so Outlook can subscribe to it, with reminders
at your lead times. Each entry carries the note id, its title, the date and the
consequence — never note content. **Import events from a calendar file** reads an
`.ics` you have saved into the vault and turns its entries into event notes,
skipping anything already imported.

No Graph API, no credentials, no mailbox access, and nothing is sent. A file
goes out; a file comes back.

Reminders themselves are in-app only: the status-bar badge, the Deadlines board
and an Obsidian notice. No OS notification and no email — a work laptop cannot be
relied on for either, and a reminder that silently fails to arrive is worse than
one that never promised to.

## Reports, the CV and the research profile

**Generate a report** picks a template, asks for whatever it needs — a month, a
year, a study — tells you how many rows it is about, and writes it into
`95 Exports/`. Five ship with the plugin:

| Template | Covers | Good for |
|---|---|---|
| Monthly facility report | one month | queue, turnaround, effort, bottlenecks |
| Per-study effort statement | one month, one study | chargeback: hours by activity, person and request, plus estimate against actual |
| Annual publication list | one year | the formatted list, with the facility's contribution beside it |
| CV | everything | composed from `85 Publications/` and `84 Profile/` |
| Research profile | everything | the narrative version: headline metrics, themes, collaborations |

Two output formats. A **markdown note** gives you pipe tables you can edit, sort
in a Base and paste into an email, with charts as embedded SVG; it carries
frontmatter, so a report stays queryable rather than becoming a dead artefact. A
**self-contained HTML page** is one file with no network that opens on a machine
with no Obsidian — print it, or export it to PDF from the browser.

Reports go through the same guards as every other export: they land in
`95 Exports/`, the confirmation names the file and the row count, and the write
is recorded in the audit ledger.

### The CV is a query, not a document

Put one note in `84 Profile/` per thing as it happens — ten seconds each — and
the CV, the appraisal return and the biosketch stop being an annual archaeology
exercise. Six note types, all optional:

```yaml
type: grant          # title, role, agency, ref, amount, currency, period, status, studies
type: service        # committee, position, organisation, scope, period
type: teaching       # course, institution, role, level, hours, period
type: supervision    # trainee, degree, role, period, outcome
type: presentation   # title, meeting, location, date, invited, format
type: award          # title, body, year
```

A few things it deliberately will not do. `year: 2025` prints as "2025", never
"2025–present" — an open-ended period is only ever what the note says. Grant
amounts are grouped by currency rather than summed, because adding SGD to GBP
gives a number that is wrong in every currency. The collaborations list includes
you, because the vault records your author position but not your name and
guessing would be wrong often enough to matter. And a section with nothing in it
is left out rather than printed empty.

### Editing a template

**Write the built-in report templates to _config** copies all five into
`_config/reports/` as YAML. Edit freely: a file there replaces the built-in with
the same `id`, or adds a template under a new one. Delete the file to go back.
Existing files are never overwritten.

A template is prose, named data blocks and live queries:

```yaml
id: monthly-facility
period: month              # month | year | all
title: SCDB monthly report — {period}
sections:
  - heading: Effort
    lede: Time logged in {period}.
    blocks:
      - block: effort
        by: activity
```

Blocks: `prose`, `request-queue`, `turnaround`, `bottlenecks`, `effort`,
`estimate-vs-actual`, `publications`, `publication-metrics`, `cv`, `portfolio`,
`query`. A name the engine does not know is reported, never guessed at.

`period` filters what *happened* — effort entries, and which year's papers are
listed. It never filters the queue: a queue is a snapshot of now, and a report
that showed one as at the end of last month would be a reconstruction this
vault does not make. Every report that shows a queue says so.

## Policies, revisions and the impact map

A policy note lives in `40 Policies/` and carries the version printed on the
document, when it takes effect, when it is next reviewed, and — the field that
does the work — what rests on it:

```yaml
---
type: policy
id: POL-DATA-REL-02
title: Release of clinical data to external collaborators
scope: institutional        # institutional | departmental | scdb | external
status: current             # draft | current | superseded | withdrawn
version: "3"                # as printed. A string: real ones include "2026-A"
effective: 2025-09-01
review_due: 2026-06-30
governs:
  - { what: gate, ref: "edata-request:extraction", clause: "5.2" }
  - { what: form, ref: "[[FORM-consent-baseline]]" }
---
```

`what` is one of `policy`, `workflow`, `gate`, `form`, `variable`, `study`,
`script`, `template`, `other`. **A dependency can be declared from either end** —
a local SOP may instead say `derives_from: [{ ref: "[[POL-DATA-REL-02]]", clause:
"5.1" }]`, which is usually who knows. Both appear on the same map.

**Name the clause.** A dependency that cites one can be told apart when the
policy changes; a dependency that does not can only ever come back as "review".

### Revising a policy

Drop the reissued document anywhere in the vault and run **Revise a policy**
(or press Revise on the Policies board). Name the new document, give the version
it is issued under, and say in one line what changed. Before anything is
written, the dialog shows which sections moved and what rests on them.

On confirming, in this order: the current text is frozen into
`40 Policies/_revisions/`, the live note's body is replaced and its frontmatter
updated, and an impact map is written beside the frozen copy and opened. A
`policy-revision` entry goes in the audit ledger.

Four verdicts:

| | Verdict | Means |
|---|---|---|
| ✕ | Clause gone | it cites a clause the new version no longer contains |
| ● | Affected | it cites a clause, and that clause moved |
| ? | Review | it cites no clause, so the change cannot be ruled out |
| ○ | Clear | it cites a clause and nothing matching it moved |

**Review is not "probably fine".** It means the vault has no basis to say
either way, and the only verdict that lets something off is one that cites a
clause. The report also lists changed clauses nothing claims to rest on — more
often an undeclared dependency than a free clause — and marks any reference
pointing at a note that is not there.

Clause numbers are read off headings (`## 5.2 Onward transfer`) and never
invented: an unnumbered heading under clause 5.2 is not clause 5.2.1.

### What the register nags about

Two findings that only show up when it is too late otherwise:

- **Nothing declared against a policy.** Not "nothing rests on it" — its
  revision will simply produce an empty impact map.
- **Never frozen.** The first real revision has nothing to diff against.
  **Freeze the current version** takes a baseline without inventing a change.

A revision is refused outright when the policy has no `version` to file the
frozen copy under, when the incoming text is identical, or when no one-line
summary is given. Reissue under the same number is allowed — issuers do that —
and the frozen copy takes a dated name so nothing is overwritten.

## Running R and Python from a note

Put an R or Python block in any note and run it. What comes back goes under the
block: printed output, errors, and any plot it drew. A record of the run is
written to `94 Runs/`, naming the interpreter version, a hash of the code that
actually ran, and the data version if you gave one.

Three ways in, all of which lead to the same dialog:

- a **Run** row under the block in reading view;
- **Run this R block** / **Run this Python block** in the editor's right-click
  menu, which is the one that works while you are editing;
- the **Run a code block from this note** command.

### Nothing runs until you say so

Opening a note runs nothing. Loading the vault runs nothing. Syncing runs
nothing. Every route opens a dialog first, and that dialog shows you the whole
block, which interpreter will run it, where it will run, and what it will
write. A block in a note is code somebody wrote; reading it is the point.

A block fenced ```` ```python no-run ```` is never offered — for the block in an
SOP that shows what *not* to do.

### Point it at your interpreters first

Settings → SCDB Cockpit → **Running code**. Give the full path to `Rscript.exe`
and to `python.exe`; a bare `python` is not enough, because the machine this is
built for has neither on `PATH`.

Press **Test** next to each. It reports the version it found and, for Python,
which of matplotlib, pandas and numpy it can actually import — which is worth
more than the version. Python runs isolated by default (`-I`), and that flag
also hides anything installed with `pip install --user`. If Test says no
matplotlib, switch **Python isolation** to *Allow per-user packages*: the
working directory stays off `sys.path` and `PYTHONPATH` is still ignored.

### Where it runs, and what it can touch

In a temporary folder outside the vault, as a separate process. A file the block
writes lands there and is discarded — only plots come back, and only files the
harness itself named. R starts with `--vanilla` and Python with isolation flags,
so a stray `.Rprofile` or a `random.py` sitting in the vault cannot get itself
executed or imported.

Every run has a timeout and a **Stop** button. Obsidian stays responsive
throughout, and stopping costs nothing.

### What ends up in the note, and what ends up in the record

The note gets a plain `text` block under the code, replaced each time you re-run
rather than piling up, plus the figures embedded. It is ordinary markdown; a
vault opened without this plugin reads exactly the same.

The history lives in `94 Runs/`. Each record says what ran, under which
interpreter, when, for how long, how it ended, and keeps a verbatim copy of the
code — so "which code produced this figure" stays answerable after the note has
moved on. If you did not name a dataset and version, the record says so rather
than implying the data is pinned when only the code is.

## The interpreter console

A live R or Python session in a pane, for the exploring you do *before* you know
what is worth keeping. Open it with **Open the interpreter console**. Type into
the box at the bottom and press **Run** (or Ctrl+Enter); Ctrl+Up and Ctrl+Down
step back through what you ran before.

Variables persist between cells, so you build up state the way you would in
RStudio rather than re-running a whole block to change one number. The side
column shows what is currently defined and the plots as they are drawn.

### Nothing here is recorded, on purpose

The console writes **no run record, no ledger entry and nothing into any note**.
That is the rule from the vault contract: exploratory console lines stay out of
the audit ledger, because a ledger with a thousand lines of somebody thinking
out loud in it is a ledger nobody will read.

The consequence is worth stating plainly, because it is a trade and not an
oversight: **the console is not a way of getting results out.** When something
is worth keeping, put the code in a block in a note and run it there — that
costs one action and produces a record naming the interpreter, a hash of the
code that actually ran, and the data version.

**Send this Python block to the console** in the editor's right-click menu, and
the **Send a code block from this note to the console** command, are the bridge
in the other direction: try the block, then run it properly once it works.

The honest limit: the interpreter is a process running as you, and it can write
anywhere you can. What is guaranteed is that *this plugin* copies nothing out of
a session. As everywhere else, the defence is that you read the code first.

### One session, and how to end it

One language at a time. Switching between R and Python ends the other session
and says so — its variables are gone, though the transcript and the plots stay
as history.

**Restart** clears the environment and gives you a fresh interpreter; it is one
click because sessions do wedge. **Stop session** ends it outright, and a cell
that is still running stops with it.

There is no *Interrupt*, and that is deliberate rather than missing. Windows has
no way to interrupt a child process the way Ctrl+C does in a terminal — every
signal available terminates it. A button labelled "Interrupt" would therefore
throw away every variable in your environment while claiming not to, so the
button says what it does.

A cell can take as long as it likes; there is no timeout, because `Sys.sleep(600)`
is a legitimate thing to type into a console. The toolbar shows the elapsed time
while it runs, and Stop is always there.

### Two things that will look like bugs

- **A cell that asks for input.** Python raises a clear error and the session
  carries on. R has no equivalent defence and such a cell simply blocks — the
  console will sit at "Running" until you press Stop.
- **Output and errors can appear out of order.** They arrive on two separate
  pipes with no ordering guarantee between them, so a warning may print above
  the line that came before it. Both are attributed to the right cell.

## Vault apps and the scratchpad

A vault app is a note in `92 Apps/`: frontmatter saying what it may reach, and
its code in a ```` ```js app ```` block. The **Apps** tab lists them. Open the
**scratchpad** instead to run JavaScript you type on the spot.

Apps are useful for the things a saved view cannot do — a calculator, an
interactive chart, a small entry form — over data the plugin already holds.

### What an app can and cannot do

An app runs in a sandboxed frame with **no access to the vault, the filesystem,
the network, or Obsidian**. It cannot read a note directly. It asks the plugin,
and the plugin answers only for the note types you allowed.

```yaml
capabilities:
  query: [scdb-request, run]   # note types it may read
  write: none                  # none | propose
  network: false               # always false
```

- **`write: none`** — it can read and draw, and change nothing.
- **`write: propose`** — it can *offer* a change. You see the note, every field
  that would move, both values, and the app's stated reason, and nothing is
  written unless you confirm. It can only propose changes to note types it may
  read, and never to `uid`, `type` or `history`.
- **`network`** is always false. An app asking for it is told no, and the board
  says so.

### Nothing runs until you say so

Opening an app note runs nothing. Loading the vault runs nothing. The first time
you run an app it asks what it may reach and shows you the code first.

If the note is later edited to ask for **more** — by you, by an update, or by
whoever sent it to you — it asks again and names exactly what changed. Asking
for less does not re-prompt. Your permissions are listed in Settings → SCDB
Cockpit, where each can be withdrawn.

Allowing an app, withdrawing it, and confirming a change it proposed all land in
the audit ledger.

### Handing one to someone else

**Export a vault app with its data** writes a self-contained HTML file to
`95 Exports/` — the app plus a frozen snapshot of what it was allowed to read.
It opens in any browser with no Obsidian and makes no network request. It is a
snapshot, not a live view, and it says so on the page.

Correspondence notes and correspondence-derived fields are left out by default,
because an export is a file that travels and those hold message content. The
confirmation names what was dropped before anything is written.

## Searching PubMed and ClinicalTrials.gov

**This is the only part of the plugin that reaches a network, and it is off.**
Everything else works with the cable pulled and always will. Turn a source on in
settings — one switch each for PubMed and ClinicalTrials.gov — and
**Search an external source** appears in the palette.

### Nothing goes out without you seeing it first

Every request shows you the **exact address** it would ask for before it sends
anything, along with which host it goes to, who runs that host, what the request
carries and what comes back. Not a summary — the literal URL, because a sentence
describing a request is the one thing you cannot check.

Nothing is written to the vault either until the results are back and you have
ticked what is worth keeping. What you keep becomes a briefing note in the
briefings folder, carrying the query, the host, the URL, the time, how many
matched and how many were kept — so a list of papers is a claim somebody can
check rather than one they have to take on trust.

### The allowlist is in the code, not in settings

There is deliberately no box to type a host into. Rule 3 says every outbound
request targets an allowlisted host, and an allowlist you can add to is not one:
a colleague, a circular or a note could talk somebody into pasting an address
in. The two hosts are constants in the source, adding one is a code change, and
the settings switches only choose between sources that already exist.

Every request is recorded in the audit ledger as a `source-fetch` row naming the
host and the search — **whether it succeeds or not**.

### Filling in a publication

**Fill in this publication from PubMed** looks a `85 Publications/` note up by
its PMID or DOI and sends *only that identifier* — nothing else from the note.
What comes back populates a form: each field shows what the note says now and
what PubMed says, and anything where the two **disagree** is flagged and starts
unticked. Filling an empty field is safe; replacing something you typed is a
decision, and it stays yours.

Authors are never offered, and neither is your author position. The note stores
authors as links to people notes and PubMed returns a list of surnames; your
position on a paper is a fact no external record holds.

A DOI is looked up through PubMed rather than a third service, which keeps the
allowlist at two hosts. A DOI PubMed has never indexed will not be found — that
is a limit of where we looked, not evidence the DOI is wrong.

### Two things worth knowing

- **PubMed silently drops a quoted phrase it cannot find** and runs the search
  without it, so you get results and none of them contain the phrase you asked
  for. When it does that, the results view says so. "How PubMed read your
  search" shows the query it actually ran, which is often not the one you typed.
- **Abstracts are not fetched.** Titles, journals, dates and identifiers are
  enough to triage, and the abstract is a paragraph of someone else's prose that
  would then live in a vault holding institutional data. The link is one click.

### Cardiac guideline feeds

Two societies, and a plain account of why not four.

- **EACTS** publishes a proper clinical practice guidelines feed. Switch it on and you get the
  most recent guidelines and consensus documents with their dates and links — including the
  joint ESC/EACTS and EACTS/STS/AATS ones.
- **ESC** publishes no feed. What it does publish is a sitemap, and the guideline topics sit
  in one place in it with a "last changed" date each. That is useful, but **the date is when
  the page changed, not when the guideline was revised** — a fixed link moves it too. The
  results say so, and so does the note, because that is the sort of thing you would otherwise
  remember for a fortnight and then forget.
- **ACC is not there, deliberately.** Their `robots.txt` asks automated clients to stay out of
  the guidelines section. That is the site telling us not to, and no amount of cleverness
  makes it all right.
- **STS is not there** because on that site "guidelines" means abstract-submission rules as
  often as it means clinical practice, and a list that mixed the two would be worse than none.

Neither absence is a dead end. Both societies publish their guidelines in journals PubMed
indexes, and the dialog offers a one-click search that finds them there — ACC/AHA in
*Circulation* and *JACC*, STS in the *Annals*. It costs no extra host, and the trade is that
it finds the published paper rather than a web announcement, a few days or weeks later.

A guideline fetch is the only kind that carries **nothing at all** — the address is fixed, so
there is no search term to send. The confirmation says so.

## Encrypted backup, and how to restore one

Set a destination folder outside the vault in Settings → SCDB Cockpit, then run
**Take an encrypted backup snapshot** from the command palette. Each snapshot is
one AES-256-GCM file named `scdb-vault-<date>-<time>.scdbak`, holding every note
and attachment the vault contains.

Three things to be clear about before relying on it:

- **The passphrase is never stored.** Not in settings, not in the vault, not in
  a keychain. If you lose it, nothing and nobody can open the archive. That is
  the property that makes the file safe to leave in an ordinary folder.
- **`.obsidian/` is not included.** Plugin settings, themes, hotkeys and the
  workspace layout are not in the snapshot. Notes and attachments are.
- **A folder on the same laptop is not off-site.** It protects against an edited
  or deleted note, not against losing the machine. If the vault is the only copy
  of a regulated data store, point the destination at something backed up
  elsewhere.

### Restoring

**Verify first, and verify regularly.** `Verify a backup snapshot` decrypts a
snapshot, checks the authentication tag, and re-hashes every file against the
manifest — writing nothing. A backup nobody has ever opened is not a backup.

To restore into a fresh vault:

1. Create an empty vault and install the plugin into
   `<vault>/.obsidian/plugins/scdb-cockpit/` (see above).
2. Open it, set the same destination folder in settings.
3. Run **Restore from a backup snapshot**, pick the file, and enter its
   passphrase. You are shown how many files will be created before anything is
   written.

**A restore only ever creates files.** Anything already in the vault is left
exactly as it is and reported as skipped, so running it against a live vault
fills gaps and can never overwrite work done since the snapshot. To roll a note
back to a snapshot version, move the current one aside first.

## When something looks wrong

**Run diagnostics self-test** produces one page of markdown covering versions,
index health and re-index time, notes that fail validation, the audit-ledger
chain, backup age, and each risky integration — probed rather than assumed.
Copy it straight into a message.

**Check link and reference integrity** reconciles the two identifiers §5.2 keeps
apart: the immutable `uid` that machine references point at, and the ordinary
wikilinks people write. It reports duplicated uids, dangling references, audit
entries naming notes that are gone, and links to notes that do not exist. The
only change it offers to make is creating a note something already links to.

## A note on data

This repository is public and contains **source code only**. No vault content,
no real request records, and no clinician or patient data belong here. Everything
under `test-vault/` is invented.

## Licence

MIT
