# SCDB Cockpit

An Obsidian plugin for running a clinical data collection facility: data-request
tracking with governance gates, effort measurement, publications, and the audit
trail behind all of it. Offline-first, no telemetry, no network calls by default.

**Status: phase A2.** Request tracking works end to end (A1) and the query
engine behind the Explore board is in (A2). Not yet released.

The design lives in [CLAUDE.md](CLAUDE.md) — architecture, the vault contract,
build phases, and the rules that constrain them.

## Develop

```bash
npm install
npm test          # Vitest over the pure domain layer
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

## A note on data

This repository is public and contains **source code only**. No vault content,
no real request records, and no clinician or patient data belong here. Everything
under `test-vault/` is invented.

## Licence

MIT
