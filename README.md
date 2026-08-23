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
