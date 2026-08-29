# Synthetic test vault

Open this folder as a vault in Obsidian to develop against.

**Everything here is invented.** No real request, clinician, study or patient
data may ever enter this folder — it is committed to a public repository
(CLAUDE.md §2 rule 1). Names below are deliberately fictional placeholders.

Run `npm run dev` and the build writes straight into
`.obsidian/plugins/scdb-cockpit/`. Enable the plugin once under
Settings → Community plugins, then use Ctrl+P → "Reload app without saving" to
pick up a rebuild.

## What is in here, and why

| Folder | Fixture | What it exists to exercise |
|---|---|---|
| `10 Requests/` | nine requests | dwell, SLA breach, bounce counts, two deliberately stranded on a retired stage |
| `30 People/` | three people | the chase-up composer reading an address — and one person with **no** address, so the composer has to cope rather than guess |
| `60 Events/` | two obligations | deadlines, and one with a recurrence rule but no next date |
| `70 Meetings/` | one set of minutes | B6 extraction: every marker style, three ways of naming an owner, a weekday date, and one deliberately ambiguous `03/04/2026` the parser must refuse |
| `75 Correspondence-fixtures/` | two threads | outreach ageing: one unanswered for weeks, one answered so it must *not* appear |
| `84 Profile/` | seven items, one per §5.9 type | B7's CV and research profile: every type composes a line, one grant is unawarded so its status shows, one period is open-ended and the rest must not be |
| `85 Publications/` | three manuscripts | a second note type for Explore to infer fields from, and the publication half of the CV |
| `00 Inbox/` | one capture | the note quick capture writes |
| `40 Policies/` | three policies plus a reissued document | C1: one institutional policy at v3 with the v4 reissue waiting in `_incoming/`, one local SOP declaring the clauses it rests on from the *far* end, and one deliberately bare policy so the register's three findings fire |
| `87 Catalogue/` | four variables | C2: one with a real three-version chain whose first version recorded only a definition, one categorical, one identifier with **no** justification, and one bumped to v2 with an empty `history` so the "only the version number survives" finding fires |
| `50 Scripts/` | six script docs and one `.R` file | C3: one per verdict the register can reach — failed run, a consumed definition revised since, an input dataset that moved, code differing from what ran, never run, and one genuinely current. `SCRIPT-cohort-build` is also the far end of the catalogue join: its three citations are stale (`@2` against a v3 variable), unversioned, and orphaned |
| `94 Runs-fixtures/` | four run records | §5.12 provenance: one corroborating its script, one whose `script_hash` differs from the note it points at, one that failed and recorded almost nothing, and one orphan naming a script nothing documents |
| `20 Studies/` | three studies | D2's governance hook: one approved for indirect identifiers, one approved for **none** (so a form on it is blocked), and one that records **no** scope at all — which reads as *uncheckable*, never as approved |
| `88 Forms/` | four REDCap forms | D2: one per verdict — blocked on governance, rejected by REDCap, questions to answer, and one deliberately clean, because a board that only ever shows problems teaches you to ignore it |
| `92 Apps/` | four vault apps | F3: one ordinary app, one that proposes writes, one deliberately greedy that prints every refusal it collects — including `fetch()` blocked by the page policy — and one with no code at all, so the board says *why* it cannot run rather than offering a Run button that does nothing |
| `50 Scripts/Invented block workbench` | five runnable blocks | F1: Python and R that work, Python and R that fail on purpose, and one fenced `no-run` that calls `shutil.rmtree` and must never be offered |
| `_config/messages/` | `chase-up.md` | the message template, so tone is the user's and not the plugin's |
| `_config/reports/` | the five B7 templates | worked examples of the report format, exactly as "Write the built-in report templates to _config" writes them — a fixture test holds them equal to the built-ins, so editing one in code without writing it out again fails the suite |

Every email address is on `example.com`, a domain reserved by RFC 2606 for
exactly this. A mis-click cannot reach a person.

### Why the correspondence fixtures live under an odd folder name

`75 Correspondence/` is blanket-gitignored everywhere, with no exception, because
§5.10 permits full message bodies and attachments in it — it is the folder most
likely to hold something that must never reach a public repo. Rather than punch a
hole in that rule for this vault, the two synthetic threads sit in
`75 Correspondence-fixtures/`, a name the rule never covered.

`94 Runs-fixtures/` exists for the same reason and reads the same way: `94 Runs/`
is blanket-ignored because a real run record names data versions, row counts and
output paths, and C3's register needs committed examples to demonstrate
provenance against. The plugin finds them either way — run records are located by
`type: run`, not by folder — and *new* ones it writes land in the real `94 Runs/`,
so they stay out of git on their own.

`50 Scripts/cohort-build.R` is pinned to LF in `.gitattributes`. It is hashed by
its bytes, and the documentation note beside it records the digest it expects; on
a machine with `core.autocrlf` on, a fresh clone would otherwise get CRLF and
"Check a script's file hash" would report a change nobody made.

The plugin still writes *new* threads to the real `75 Correspondence/` (that is
the shipped default and the actual vault contract), so anything you generate here
by composing a message stays out of git on its own. If you compose a chase-up
about a request one of the fixture threads already covers, the plugin appends to
that fixture instead and dirties the tree — `git checkout -- "test-vault/75 Correspondence-fixtures"`
puts it back.

### Running the policy revision demo dirties two files

`40 Policies/` ships the *inputs* to C1, not its output: the policy sits at
version 3 and the reissued text waits in `40 Policies/_incoming/`. Running
**Revise a policy** against it does the real thing — freezes the v3 text into
`_revisions/`, replaces the body, bumps the frontmatter and writes the impact
map — so afterwards `POL-DATA-REL-02.md` is modified and `_revisions/` exists.

`_revisions/` is gitignored, and `git checkout -- "test-vault/40 Policies"`
puts the policy note back so the demo can be run again from the top.

The fixture is built so that one revision produces all four impact verdicts:
clause 5.2 changes (**affected** — the extraction gate cites it), clause 5.4
disappears (**clause gone** — the SOP cites it), clause 5.1 is untouched
(**clear** — the SOP cites that too), and the consent form cites no clause at
all (**review**, and it resolves to no note, so it also shows *not found*).

### Forms and apps are the only notes with a body block

Every other note type in this vault keeps its payload in frontmatter. Two do
not. A `type: redcap-form` note keeps its instruments in a ```` ```yaml redcap ````
fence in the body (§7 D2), because eighty fields do not belong in frontmatter
and a body block diffs cleanly in git. A `type: vault-app` note keeps its code
in a ```` ```js app ```` fence (§5.13), for the plainer reason that JavaScript
is not frontmatter. Both use the same fence reader and the same replace rule.

Two consequences worth knowing while working here:

- The plugin reads these notes from disk rather than from Obsidian's metadata
  cache, which only holds frontmatter. That is why the Forms board loads with a
  brief "Reading the form notes…" and the others do not.
- The plugin replaces **only** the block. The prose above and below it is left
  exactly as written, which is what makes a form note somewhere you can explain
  why an instrument is shaped the way it is.

Running **Import a REDCap data dictionary** against one of these does the real
thing and dirties the note;
`git checkout -- "test-vault/88 Forms"` puts it back.

### The workbench really runs, and needs interpreters to do it

`50 Scripts/Invented block workbench` is where F1 is exercised by hand. Nothing
on it runs on its own (rule 12): a block runs from **Run**, from the editor's
right-click menu, or from the palette, and each shows the code first.

- **It needs paths set.** Settings -> SCDB Cockpit -> Running code. With neither
  set, the dialog refuses and says what to fill in - which is itself worth
  seeing once.
- **Running it dirties the note.** The output block and an embedded figure are
  written into it, a record lands in `94 Runs/`, and a `code-run` row is
  appended to the ledger. `git checkout -- "test-vault/50 Scripts"` puts the
  note back; delete the run records and PNGs by hand. A committed test asserts
  the note carries no output and that `94 Runs/` is empty, so a stray artefact
  fails the suite rather than reaching the repo.
- **The two "fails on purpose" blocks are the interesting ones.** Both should
  report the line number *in this note*, not a line inside the harness. If a
  traceback starts naming `runner.py`, the block-from-its-own-file arrangement
  has been broken.
- **The `no-run` block calls `shutil.rmtree`.** It is there to be refused. If a
  Run button ever appears under it, the opt-out has stopped working.

### The app fixtures run real code, and nothing runs on its own

Rule 12: opening one of these notes runs nothing, and loading the vault runs
nothing. An app starts only from **Run** on the Apps board or the palette, and
the first run of each asks what it may reach and shows the code it will run.

Three things worth knowing while working here:

- **Your consent is stored in the plugin's `data.json`, which is gitignored.**
  It is not in the app note, deliberately — a consent stored next to the thing
  it authorises is not a consent. So a fresh clone starts with every app in
  *Not yet allowed to run*, which is the correct starting state and not a
  missing fixture.
- **`APP-invented-overreach` is the one to run when changing anything in
  `domain/apps/` or `sandbox/`.** It prints four refusals — a note type outside
  its manifest, another app's notes, a protected field, and a network call — and
  each is enforced somewhere the app cannot reach. If any line changes to "this
  should not have happened", a guard has gone.
- **`APP-invented-triage` writes.** Confirming one of its proposals really does
  set `priority: high` on a request fixture and really does append to the
  ledger. `git checkout -- "test-vault/10 Requests"` puts it back.
