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
  defaultBackup,
  defaultSettings,
  isMode,
  type BackupConfig,
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

  if (merged.hatFilter !== "mode" && merged.hatFilter !== "all") {
    notes.push(`Unknown hat filter ${JSON.stringify(raw.hatFilter)}; reset to "mode".`);
    merged.hatFilter = "mode";
  }

  // Backup config: repaired field by field, never wholesale. Replacing the
  // block because one number is wrong would silently forget a destination the
  // user typed once and has not looked at since (§7 A4).
  const backup = repairBackup(merged.backup, notes);
  merged.backup = backup;

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
  // Each future schema bump appends a step here.

  if (storedVersion > 0 && storedVersion < 2) {
    // v2 added `hatFilter`. The field repair above has already supplied the
    // default, so this step only records that it happened: a settings file that
    // changes shape without a line in the trail is exactly what makes an
    // upgrade hard to diagnose on a laptop with no console (§7 A4).
    notes.push('Migrated v1 → v2: added the hat filter, defaulting to the mode you are wearing.');
  }

  if (storedVersion > 0 && storedVersion < 3) {
    notes.push(
      "Migrated v2 -> v3: added encrypted backup settings. No destination is set, " +
        "so nothing is backed up until you choose a folder.",
    );
  }

  merged.schemaVersion = CURRENT_SETTINGS_VERSION;

  const changed = JSON.stringify(raw) !== JSON.stringify(merged);
  if (changed && notes.length === 0) {
    notes.push("Settings normalised to the current schema.");
  }

  return { settings: merged, changed, notes, fromFuture: false };
}

/**
 * Bring the backup block back to something usable without discarding it.
 *
 * `keep` and `intervalDays` are clamped rather than reset: a hand-typed 0 means
 * "I want fewer", not "give me the default seven", and clamping to 1 keeps the
 * intent while making the sweep safe. A destination is never invented here —
 * validating that it exists is the service's job, and this module cannot see a
 * filesystem.
 */
function repairBackup(value: unknown, notes: string[]): BackupConfig {
  const base = defaultBackup();
  if (!isRecord(value)) {
    if (value !== undefined) notes.push("Backup settings were not readable; reset to defaults.");
    return base;
  }

  const str = (key: keyof BackupConfig): string =>
    typeof value[key] === "string" ? (value[key] as string) : (base[key] as string);
  const num = (key: "keep" | "intervalDays", min: number, max: number): number => {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return base[key];
    const clamped = Math.min(max, Math.max(min, Math.round(raw)));
    if (clamped !== raw) notes.push(`Backup ${key} was ${raw}; using ${clamped}.`);
    return clamped;
  };

  return {
    destination: str("destination").trim(),
    keep: num("keep", 1, 365),
    intervalDays: num("intervalDays", 1, 365),
    lastAt: str("lastAt"),
    lastName: str("lastName"),
  };
}
