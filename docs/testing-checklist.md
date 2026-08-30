# What to test on the work laptop

Everything in this plugin was built on a machine that is not the one it has to work on. Some
of it could be verified here, some could not, and a few things are **blocked** until you
supply something only the target machine has.

This page is the list, ordered so the answers that unblock other work come first. Tick as you
go. Where something fails, the useful report is *what you pressed, what you expected, what you
saw* — most failures here will be environmental rather than logical, and the environment is
the part I cannot see.

**Do all of this in a scratch vault first, not the real one.** Copy `test-vault/` across, or
make an empty vault and let the plugin create its folders. Nothing below needs real data.

---

## Legend

| Mark | Meaning |
|---|---|
| **Blocked** | Cannot be finished until you provide something. Named in each case. |
| **Unverified** | Built and unit-tested, never run against the real thing. |
| **Verified here** | Ran on the dev machine. Re-check only if it misbehaves. |

---

## 1. First, the things that unblock everything else

### 1.1 Does it load at all — **Unverified on your Obsidian**

1. Copy `main.js`, `manifest.json`, `styles.css` into
   `<vault>/.obsidian/plugins/scdb-cockpit/`.
2. Enable it under **Settings → Community plugins**.
3. Open the console (Ctrl+Shift+I) once and look for red.

**Pass:** loads, no errors, a hat appears in the status bar.
**If it refuses:** note your Obsidian version. `manifest.json` declares a `minAppVersion`; an
older build is the likely cause and it is a one-line fix.

### 1.2 Obsidian version and core Bases — **Unverified**

Run **Create Bases dashboards**.

- On Obsidian ≥1.10 you should get `.base` files in `90 Dashboards/` and native tables.
- On anything older it should say Bases is unavailable **and everything else must still work**.

**This is the check that matters most**, because the whole Bases layer is meant to be optional.
If an older Obsidian breaks any non-Bases view, that is a real bug.

### 1.3 The real eData workflow — **Blocked on you**

The stages shipped in `_config/workflows/edata-request.yaml` are **placeholders**. Before real
use, replace them with the actual institutional stages, owning parties, gates and target
durations.

Then test the migration path, because it is guaranteed to be exercised at least once:

1. Create two or three requests on the old stages.
2. Edit the workflow spec — rename a stage, bump `version`.
3. Reload. Those requests should be **quarantined** and listed in the migration view.
4. Run **Migrate requests to the current workflow version**, map old → new, apply.

**Pass:** no note is silently remapped, every mapping lands in `history` and the audit ledger.

### 1.4 Where a backup may legitimately go — **Blocked on you**

Approved network share, managed backup path, or an encrypted USB? And **is there already a
backup covering the vault, or is this the only copy?** The answer changes whether backup is a
safety net or the whole safety story. Until it is answered, do not rely on it.

---

## 2. Composing messages (B1)

**Unverified — three specific unknowns, all answerable in about a minute.**

Settings → Messages → **Test the handlers**.

- [ ] Does `mailto:` open **classic Outlook**, the new Outlook, or nothing?
- [ ] Does the Teams link open a chat with the message pre-filled?
- [ ] **What is the real length ceiling before a draft arrives truncated?** Compose a chase-up
      on a request with a long title, lengthen it, and find where it breaks. Then set
      *Longest link to open* just below that. This one has a real failure mode: a chase-up
      email silently cut in half.

> On the dev machine `mailto:` reached the **new** Outlook. That may not be what happens on a
> managed build, and it matters, because the COM reader in §7 needs the **classic** one.

---

## 3. Reading Outlook directly (E2)

**Unverified — never run against a mailbox.** See [outlook-reader.md](outlook-reader.md).

Do these in order:

- [ ] Settings → Reading Outlook directly → **Show what runs**. Reads nothing. Confirms what
      you would be authorising, and is the page to hand to IT.
- [ ] **Check this machine** — one press, asks Outlook its version. Tells you whether classic
      Outlook is what answers here.
- [ ] Only then switch it on, **set the window to one or two days**, and run
      **Read new mail from Outlook**. On a first run with the default fortnight, every thread
      is new and a fortnight of institutional email arrives at once.
- [ ] Check `82 Audit/` gained a `mailbox-read` row with counts and no content.
- [ ] Drag one of those same messages in as a `.msg` (§4) and confirm it lands in the **same**
      thread, not a second one.

**If PowerShell is blocked or restricted:** nothing else in the plugin is affected — it appears
nowhere else in what ships. Report the exact wording of the failure. Constrained Language Mode
in particular currently gives an unhelpful message from the **Check this machine** button; that
is a known gap with a small fix waiting.

---

## 4. Correspondence from files (Tier 1)

**Verified here on synthetic files; unverified on real institutional mail.**

- [ ] Save two or three messages from a real thread as `.msg`, drag into the vault, run
      **Import saved email files**.
- [ ] Do replies and forwards of the same conversation collect into **one** thread?
- [ ] Is `awaiting` right — them, or you? This is the field the holdup board runs on, and it
      depends on your own addresses being set in settings. Set them first.
- [ ] Try a message with an accented name, a £ or € sign, and a smart quote. Encoding is where
      mail readers rot.

---

## 5. REDCap forms (D2)

### 5.1 Data dictionary CSV — **Unverified against your instance**

- [ ] **Import** a real data dictionary exported from your REDCap. Does it parse?
- [ ] **Export** it straight back out. Diff the two files — they should be identical.
- [ ] Then edit a form in the UI, export, and import that into REDCap. Does REDCap accept it
      without complaint?

The round-trip is tested here against synthetic dictionaries. Your instance's version is the
part that cannot be simulated.

### 5.2 Project ODM XML — **Blocked on you**

**Not built, deliberately.** REDCap creates a project from a *REDCap project XML* file — CDISC
ODM 1.3.2 plus REDCap's own extensions — and those extensions vary by version. Guessing the
schema would produce a file that looks right and imports wrong.

**To unblock:** export one real project XML from your instance and note the **REDCap version
number** (bottom of any REDCap page). Nothing to test until then.

### 5.3 The governance hook

- [ ] Flag a field as an identifier on a form linked to a study whose IRB scope does not cover
      it. It should be refused, or flagged before export.

---

## 6. Running code (F1, F2)

**Blocked on you: the actual interpreter paths.**

Settings → Compute. You need the real paths on that machine:

- the portable R build's `Rscript.exe`
- the miniconda `python.exe`, or the environment name

- [ ] Press **test interpreter** for each. It should report a version it actually found.
- [ ] Also answer: do conda environments there need activation, or can they be invoked by
      absolute path? **Absolute path is strongly preferred** — activation on a locked-down
      machine is where this usually breaks.
- [ ] Run an R block that draws a plot. Does the plot land in the note?
- [ ] Run a Python block using matplotlib. Same question.
- [ ] Check `94 Runs/` gained a run record naming the interpreter version and script hash.
- [ ] Start something slow and **kill it from the UI**. Obsidian must stay responsive.
- [ ] Open the console (F2), run a few things, then deliberately wedge it and use
      **restart the session**.

> Known trap from the dev machine: `python -I` hides packages installed with `pip --user`. If
> an import fails there but works in a terminal, that is why.

---

## 7. External sources (E1)

**Blocked on a firewall question, not a configuration one.** The allowlist is fixed in code at
four hosts. Off by default.

- [ ] Can that machine reach `eutils.ncbi.nlm.nih.gov`? (PubMed)
- [ ] `clinicaltrials.gov`?
- [ ] `www.eacts.org`? (EACTS guideline feed)
- [ ] `www.escardio.org`? (ESC sitemap)
- [ ] With one enabled, run **Search an external source** and check a `source-fetch` row lands
      in the ledger **whether or not it succeeded** — a failed request still left the machine.
- [ ] **Fill in this publication from PubMed** on a publication note with a DOI or PMID.

If they are all blocked, say so and this track simply stays off.

---

## 8. Diagrams and PowerPoint (D1)

**Partly verified here; the part that matters is not.**

- [ ] **Draw the workflow lifecycle** — does a diagram render at all? (Core Mermaid must be
      working; the diagnostics self-test probes this.)
- [ ] **Copy PNG to the clipboard**, then paste into an actual PowerPoint slide. This is the
      feature that earns the track, and clipboard image writing is exactly the thing a managed
      machine may restrict.
- [ ] Save an `.svg` next to the note and open it.
- [ ] **Draw what actually happened to a request** on a request with a few stage changes.

---

## 9. Backup and recovery (A4)

**Do not skip this one.** A backup that has never been restored is not a backup, and this vault
may be the only copy of a regulated data store.

- [ ] **Take an encrypted backup snapshot** to the destination from §1.4.
- [ ] **Verify a backup snapshot**.
- [ ] **Restore into an empty vault** and confirm the notes are all there.
- [ ] Deliberately give the wrong passphrase and confirm it fails cleanly rather than
      producing a corrupt vault.
- [ ] Note how long a snapshot of a realistic vault takes, and how large it is.

The passphrase is never stored. Losing it means losing the archive; confirm you have it
somewhere durable before you rely on this.

---

## 10. The daily loop (B1, B2, A3)

Mostly verified here, but this is the part you will actually live in, so it is worth an
honest week of use before trusting the numbers.

- [ ] **Capture a note to the inbox** on a hotkey — does it get out of the way fast enough to
      use mid-conversation?
- [ ] **Write today's briefing** — is it worth reading, or is it noise? Say which sections are
      useless; they are configurable.
- [ ] **Build a meeting agenda for someone** before a real meeting. Did it save you the prep?
- [ ] Timer: start it, then **force-quit Obsidian**. On restart it should offer to recover the
      running timer, losing at most a minute.
- [ ] Leave the machine idle with the timer running. It should ask: keep, discard, or split.
- [ ] Add and edit a past time entry — everyone forgets to stop a timer.
- [ ] Switch hats (Ctrl+Shift+1/2/3) and confirm the boards, the default activity and quick
      capture all follow.

---

## 11. Governance surfaces (A1, C1, C2, C3)

- [ ] Drive one request end to end through every stage.
- [ ] Try an **illegal transition** — it must refuse with a plain-English reason.
- [ ] **Override a gate**, and confirm it refuses to proceed without a typed reason.
- [ ] **Verify audit ledger**. Then edit a past row by hand and run it again — it must report
      the first row that no longer reconciles. *This is the check that proves the ledger is
      worth anything.*
- [ ] **Revise a policy** — is the impact map (which SOPs, gates and templates are affected)
      actually useful, or just a diff with ambition?
- [ ] **Which definition was in force** on a date, for a variable you have revised.
- [ ] **Check link and reference integrity** after deliberately renaming a note.

---

## 12. Reports and the CV (B7)

**Blocked on you for the CV: which format does the institution actually require?** A local
template, an NMRC or grant biosketch layout, or free-form? Supply one real example and the
template gets built from it.

- [ ] **Generate a report** for each shipped template: monthly facility report, per-study
      effort statement, annual publication list, CV, research profile.
- [ ] Export one to PDF through Obsidian's export, and one to HTML.
- [ ] Open the HTML in a browser **with no network** — it must be self-contained.
- [ ] Check the export confirmation names the file and row count, and that an `export` row
      lands in the ledger.

---

## 13. Vault apps (F3)

- [ ] **Run a vault app**, then edit its manifest to ask for more capability. It must
      **re-prompt** and name exactly what changed.
- [ ] **Blocked-ish, verify do not assume:** write an app with an infinite loop. Does Obsidian
      stay usable, and does the watchdog offer to tear it down? This tells us whether that
      Electron version isolates sandboxed iframes into their own process, which determines how
      hard the watchdog has to work.

---

## 14. Reconciliation with the real system — **Blocked on you**

The vault is a working tracker, not the system of record.

- [ ] Does the institutional eData system expose a request ID you can copy into `external_ref`?
- [ ] Is there **any** export at all — even a manual CSV — that a reconciliation check could
      compare against?

Until there is, `last_reconciled` is a date you type by hand, which is honest but manual.

---

## 15. Performance, on a real vault

- [ ] **Rebuild the note index** on a vault with a realistic number of notes. Target is under
      a second for 5,000 notes; report what you actually see.
- [ ] Open the cockpit at full width and at ~300px sidebar width.
- [ ] Check it in the theme you actually use, in both light and dark.

---

## 16. When something is wrong

Run **Run diagnostics self-test** and copy the report into a message. It names interpreters and
versions, protocol handlers, index health, notes failing schema validation, ledger chain
status, backup age, and both Obsidian and plugin versions — which is most of what I would
otherwise have to ask you for one question at a time.

It contains note names from your vault, so **read it before pasting it anywhere**.

---

## Summary of what is blocked on you

| # | Needed | Unblocks |
|---|---|---|
| 1.3 | Real eData stages, owners, gates, durations | The workflow being true rather than plausible |
| 1.4 | An approved backup destination, and whether another backup exists | Trusting A4 |
| 5.2 | One real REDCap project XML + the REDCap version | ODM XML export |
| 6 | Real `Rscript.exe` and `python.exe` paths; whether conda needs activation | F1/F2 |
| 7 | Which of the four hosts the firewall permits | E1 |
| 12 | One real example of the CV format required | The CV template |
| 14 | Whether eData exposes an ID and any export | Reconciliation |
