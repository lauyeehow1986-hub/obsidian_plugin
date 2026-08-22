# SCDB Cockpit

An Obsidian plugin for running a clinical data collection facility: data-request
tracking with governance gates, effort measurement, publications, and the audit
trail behind all of it. Offline-first, no telemetry, no network calls by default.

**Status: phase A4 (in progress).** Request tracking works end to end (A1), the
query engine behind the Explore board is in (A2), core Bases is layered on where
it exists (A2b), the cockpit and its analytics are in (A3), and encrypted backup
with restore and verification has landed (A4). Bases is never a dependency: on
an Obsidian without it, every view still works. Not yet released.

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

## A note on data

This repository is public and contains **source code only**. No vault content,
no real request records, and no clinician or patient data belong here. Everything
under `test-vault/` is invented.

## Licence

MIT
