# Changelog

All notable changes to SCDB Cockpit. Governance-gate changes get their own
clearly marked entry (CLAUDE.md §10).

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
