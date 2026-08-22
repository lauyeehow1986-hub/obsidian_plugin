# SCDB Cockpit

An Obsidian plugin for running a clinical data collection facility: data-request
tracking with governance gates, effort measurement, publications, and the audit
trail behind all of it. Offline-first, no telemetry, no network calls by default.

**Status: phase B1.** Track A is complete: request tracking end to end (A1),
the query engine behind the Explore board (A2), core Bases layered on where it
exists (A2b), the cockpit and its analytics (A3), and encrypted backup with
restore, verification, a diagnostics self-test and an integrity check (A4).
B1 adds the daily rhythm — quick capture, a daily briefing, meeting agendas,
the chase-up composer and outreach ageing. Bases is never a dependency: on an
Obsidian without it, every view still works. Not yet released.

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
