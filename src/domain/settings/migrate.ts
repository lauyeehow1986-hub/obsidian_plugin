/**
 * Settings migration. Pure — no Obsidian imports.
 *
 * Two rules drive every decision here (CLAUDE.md §2 rule 8, §10):
 *   1. Never lose a key we do not recognise. A newer build may have written it.
 *   2. Never downgrade settings written by a NEWER version of the plugin. If a
 *      vault has been opened by a future build, we leave its settings alone
 *      rather than silently rewriting them to a shape it no longer expects.
 */

import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_FOLDERS,
  defaultSettings,
  isMode,
  type FolderKey,
  type ScdbSettings,
} from "./schema.js";

export interface MigrationResult {
  settings: ScdbSettings;
  /** True when the stored form differed from what we now hold — caller should persist. */
  changed: boolean;
  /** Human-readable trail. Surfaced in diagnostics (A4), never silently swallowed. */
  notes: string[];
  /** Set when stored settings come from a newer plugin build. */
  fromFuture: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bring stored settings up to the current schema.
 *
 * @param raw whatever `loadData()` returned — may be null, partial, or foreign.
 */
export function migrateSettings(raw: unknown): MigrationResult {
  const notes: string[] = [];

  if (!isRecord(raw)) {
    return {
      settings: defaultSettings(),
      changed: true,
      notes: ["No stored settings found; initialised defaults."],
      fromFuture: false,
    };
  }

  const storedVersion =
    typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
      ? raw.schemaVersion
      : 0;

  // Rule 2: a newer build has written these. Do not touch them.
  if (storedVersion > CURRENT_SETTINGS_VERSION) {
    notes.push(
      `Settings were written by a newer version (schema v${storedVersion}, this build understands v${CURRENT_SETTINGS_VERSION}). ` +
        `Left unchanged to avoid data loss.`,
    );
    return {
      settings: raw as ScdbSettings,
      changed: false,
      notes,
      fromFuture: true,
    };
  }

  // Start from defaults, then overlay everything stored, so unknown keys survive.
  const base = defaultSettings();
  const merged: ScdbSettings = { ...base, ...raw } as ScdbSettings;

  if (storedVersion === 0) {
    notes.push("Stored settings had no schema version; treated as pre-v1.");
  }

  // --- Field-level repair -------------------------------------------------
  // Applied on every load, not only on version bumps: a hand-edited data.json
  // is a normal occurrence in a markdown-first tool.

  if (!isMode(merged.mode)) {
    notes.push(`Unknown mode ${JSON.stringify(raw.mode)}; reset to "${base.mode}".`);
    merged.mode = base.mode;
  }

  if (typeof merged.actor !== "string") {
    notes.push("Actor was not a string; reset to empty.");
    merged.actor = "";
  }

  if (merged.bases !== "auto" && merged.bases !== "off") {
    notes.push(`Unknown bases setting ${JSON.stringify(raw.bases)}; reset to "auto".`);
    merged.bases = "auto";
  }

  // Folders: fill gaps, keep customised values, drop nothing.
  const folders: Record<string, unknown> = isRecord(merged.folders) ? { ...merged.folders } : {};
  const missing: string[] = [];
  for (const key of Object.keys(DEFAULT_FOLDERS) as FolderKey[]) {
    const value = folders[key];
    if (typeof value !== "string" || value.trim() === "") {
      folders[key] = DEFAULT_FOLDERS[key];
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    notes.push(`Filled default paths for folders: ${missing.join(", ")}.`);
  }
  merged.folders = folders as Record<FolderKey, string>;

  // --- Versioned migrations ------------------------------------------------
  // Each future schema bump appends a step here, e.g.:
  //   if (storedVersion < 2) { ...; notes.push("Migrated v1 -> v2: ..."); }

  merged.schemaVersion = CURRENT_SETTINGS_VERSION;

  const changed = JSON.stringify(raw) !== JSON.stringify(merged);
  if (changed && notes.length === 0) {
    notes.push("Settings normalised to the current schema.");
  }

  return { settings: merged, changed, notes, fromFuture: false };
}
