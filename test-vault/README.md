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
| `75 Correspondence-fixtures/` | two threads | outreach ageing: one unanswered for weeks, one answered so it must *not* appear |
| `85 Publications/` | one manuscript | a second note type for Explore to infer fields from |
| `00 Inbox/` | one capture | the note quick capture writes |
| `_config/messages/` | `chase-up.md` | the message template, so tone is the user's and not the plugin's |

Every email address is on `example.com`, a domain reserved by RFC 2606 for
exactly this. A mis-click cannot reach a person.

### Why the correspondence fixtures live under an odd folder name

`75 Correspondence/` is blanket-gitignored everywhere, with no exception, because
§5.10 permits full message bodies and attachments in it — it is the folder most
likely to hold something that must never reach a public repo. Rather than punch a
hole in that rule for this vault, the two synthetic threads sit in
`75 Correspondence-fixtures/`, a name the rule never covered.

The plugin still writes *new* threads to the real `75 Correspondence/` (that is
the shipped default and the actual vault contract), so anything you generate here
by composing a message stays out of git on its own. If you compose a chase-up
about a request one of the fixture threads already covers, the plugin appends to
that fixture instead and dirties the tree — `git checkout -- "test-vault/75 Correspondence-fixtures"`
puts it back.
