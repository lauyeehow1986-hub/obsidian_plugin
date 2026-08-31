---
name: releasing-the-plugin
description: Use when cutting a release of SCDB Cockpit — bumping the version, tagging, publishing to GitHub, or answering whether the bytes a user would download are the bytes actually running in Obsidian.
---

# Releasing the plugin

## Overview

**A build is not a release, and a release is not verified until the released
bytes have run.** The artefact that travels by sneakernet to the work laptop is
the zip, so the zip is what gets installed, hashed and read back out of the
running app.

`CLAUDE.md` §10 is the authority on *what* a release touches and *why*. This is
the order of operations, the commands, and the traps.

## When to use

- Any version bump, however small.
- Publishing or re-publishing a GitHub release.
- Anyone asks "is the fix in the release?" or "which version is running?"
- **Not** for verifying a feature mid-development — that is a `npm run dev`
  loop against `dist/scdb-cockpit/`, and it proves nothing about a release.

## The checklist, and what enforces it

`tests/release.test.ts` enforces steps 1–5 by reading the files and failing.
When it goes red, fix the file it names; never relax the assertion.

| # | Step | Enforced |
|---|------|----------|
| 1 | `version` in `manifest.json` — never reuse a dated number | yes |
| 2 | matching `versions.json` entry with the real `minAppVersion` | yes |
| 3 | `## Unreleased` → `## [x.y.z] — YYYY-MM-DD` in `CHANGELOG.md` | yes |
| 4 | status **and** download lines in `README.md` | yes |
| 5 | version in `docs/index.md` | yes |
| 6 | `npm run package` | no |
| 7 | commit, `git tag -a vx.y.z`, push both | no |
| 8 | `gh release create` with the zip **and** the three loose files | no |

The stale-version guard is the half-update catcher: it greps both prose files
for any *other* `<major>.N.N`, so bumping the download line and forgetting the
status line fails the suite.

```bash
npm.cmd test && npm.cmd run package
```

`package` runs typecheck → production build → smoke test → zip. **`build`
writes the three files but no zip** — a stale 8 KB zip once sat in `dist/` for a
month looking current against a real bundle of 860 KB. Delete the previous
version's zip when the number changes.

Step 8, all four assets — the loose files are not redundant, because a managed
laptop is where a downloaded archive gets quarantined:

```bash
gh release create v0.3.1 dist/scdb-cockpit-0.3.1.zip dist/scdb-cockpit/main.js dist/scdb-cockpit/manifest.json dist/scdb-cockpit/styles.css --title "0.3.1" --notes-file notes.md
```

## Verifying the released bytes

Copying `dist/scdb-cockpit/` into the vault proves nothing about the zip. The
only in-app proof is this, in order:

1. **Extract the released zip** over
   `test-vault/.obsidian/plugins/scdb-cockpit/`, keeping `data.json` — settings
   set by hand in a fresh vault do not survive first open, so never recreate it.
2. **Hash what you wrote** (`Get-FileHash main.js`) and keep the first 16 hex
   digits to quote in the report.
3. **Genuine reload from the palette** — "Reload app without saving".
   `ctrl+r` re-renders the view while the *old* `main.js` keeps running, which
   makes a shipped feature look broken.
4. **Run diagnostics** ("Run diagnostics self-test") and read **Plugin version**.
   That single row is the proof, and it arrives beside the ledger chain check,
   index time and every integration probe.
5. **Open devtools** (`ctrl+shift+i`) and confirm no errors.

Still unsure which code is running? Ask it directly rather than inferring:

```js
app.plugins.plugins['scdb-cockpit'].<service>.<method>.toString()
```

Driving Obsidian here needs computer-use plus PowerShell window control; the
machine-specific gotchas live in the `obsidian-ui-automation` memory, not here.

## Traps

| Trap | What actually happens |
|---|---|
| Backslashes through a Bash heredoc | `"C:\\SOPs"` lands as `C:SOPs`; a Python heredoc turns `b"\0"` into a space and has written raw NULs into `.ts`. **Any content with a backslash goes through Write/Edit**, then grep for control bytes. |
| A test run dirties the test vault | Obsidian reformats `community-plugins.json` and note line endings on open; composing or transitioning rewrites fixtures and breaks `tests/fixtures.test.ts`. `git checkout --` them and delete generated notes before committing. |
| Committing from the wrong root | A stray `.git` in `%USERPROFILE%` points at another public repo. `git rev-parse --show-toplevel` **before every git operation**. |
| `package.json` version | Reads `0.1.0` and nothing consumes it. Leave it; `manifest.json` is the version. |

## Common mistakes

- **Claiming a track is complete in `README.md`.** Adding a phase to the plan
  silently falsifies "every build track is implemented". Re-read the status
  paragraph against the plan on every release, and name what each unbuilt item
  is waiting on.
- **Reporting the build's test count as the release's.** Run the suite after the
  version bump, not before it.
- **Announcing a release before `gh release view` lists all four assets.**
