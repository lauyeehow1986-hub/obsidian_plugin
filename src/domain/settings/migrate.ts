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
  defaultBriefing,
  defaultComms,
  defaultEffort,
  defaultEvents,
  defaultSettings,
  isMode,
  type BackupConfig,
  type BriefingConfig,
  type CommsConfig,
  type EffortConfig,
  type EventsConfig,
  type FolderKey,
  type ScdbSettings,
} from "./schema.js";
import { MIN_IDLE_MINUTES, type TimerState } from "../effort/timer.js";

export interface MigrationResult {
  settings: ScdbSettings;
  /** True when the stored form differed from what we now hold — caller should persist. */
  changed: boolean;
  /** Human-readable trail. Surfaced in diagnostics (A4), never silently swallowed. */
  notes: string[];
  /** Set when stored settings come from a newer plugin build. */
  fromFuture: boolean;
  /**
   * Set when there was nothing readable to migrate.
   *
   * The caller must not persist in this case. A read that comes back empty is
   * ambiguous — a first install and a failed read look identical from here —
   * and writing defaults over the second silently destroys a configured backup
   * destination and actor. Defaults are what the next load produces anyway, so
   * saving them gains nothing and can only lose something.
   */
  fromNothing: boolean;
}

/**
 * What the last settings read actually was.
 *
 * `loaded` — a stored file was read. `first-install` — there is no file yet.
 * `unreadable` — there IS a file and we could not use it.
 */
export type SettingsReadState = "loaded" | "first-install" | "unreadable";

/**
 * Tell a first install apart from a settings file we could not read.
 *
 * `loadData()` returns null for both: no `data.json` at all, and a `data.json`
 * that would not parse. A byte-order mark or a half-finished write is enough —
 * Obsidian catches the parse error and hands back null either way.
 *
 * `fromNothing` already stops us overwriting the second case, but running on
 * defaults without saying so is the silent failure §8 forbids. On the work
 * laptop there is no console, so the only symptoms would be a wrong actor in
 * the audit ledger and a backup destination that looks like it was never set —
 * both of which read as "I must have forgotten to configure it", not as a
 * fault.
 *
 * @param fileExists false when there is no file OR when we could not check;
 *   an unverifiable absence is reported as a first install rather than raised
 *   as an alarm we cannot substantiate.
 */
export function settingsReadState(fromNothing: boolean, fileExists: boolean): SettingsReadState {
  if (!fromNothing) return "loaded";
  return fileExists ? "unreadable" : "first-install";
}

/** Plain language plus a next action, per §8. Names the file; carries no content. */
export function unreadableSettingsMessage(path: string): string {
  return (
    `SCDB Cockpit could not read its settings (${path}). The file is there but ` +
    `unusable, so the plugin is running on defaults — the actor and backup ` +
    `destination are not the ones you set. Nothing has been overwritten. ` +
    `Repair or delete that file, then reload Obsidian.`
  );
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
      fromNothing: true,
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
      fromNothing: false,
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

  merged.comms = repairComms(merged.comms, notes);
  merged.briefing = repairBriefing(merged.briefing, notes);
  merged.effort = repairEffort(merged.effort, notes);
  merged.events = repairEvents(merged.events, notes);

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

  if (storedVersion > 0 && storedVersion < 4) {
    notes.push(
      "Migrated v3 -> v4: added message composition and the daily briefing. " +
        "The briefing is off until you turn it on, and nothing is ever sent — " +
        "the plugin composes a draft and hands it to Outlook or Teams.",
    );
  }

  if (storedVersion > 0 && storedVersion < 5) {
    notes.push(
      "Migrated v4 -> v5: added the effort timer. No timer is running, and the " +
        "activity vocabulary comes from _config/vocabularies.yaml when you write one.",
    );
  }

  if (storedVersion > 0 && storedVersion < 6) {
    notes.push(
      "Migrated v5 -> v6: added recurring obligations and the calendar bridge. " +
        "Lead reminders default to 30, 7 and 1 days where a note declares none, " +
        "and nothing is written to a calendar until you ask for it.",
    );
  }

  merged.schemaVersion = CURRENT_SETTINGS_VERSION;

  const changed = JSON.stringify(raw) !== JSON.stringify(merged);
  if (changed && notes.length === 0) {
    notes.push("Settings normalised to the current schema.");
  }

  return { settings: merged, changed, notes, fromFuture: false, fromNothing: false };
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
/**
 * Clamp the composer's numbers rather than resetting them.
 *
 * The URI ceiling is the one that matters: too high and a chase-up arrives
 * truncated, too low and nothing can be composed at all. §11 says the real
 * figure has to be measured on the target machine, so the bounds here are
 * deliberately wide and the default deliberately conservative.
 */
function repairComms(value: unknown, notes: string[]): CommsConfig {
  const base = defaultComms();
  if (!isRecord(value)) {
    if (value !== undefined) notes.push("Message settings were not readable; reset to defaults.");
    return base;
  }

  const clamp = (key: "uriCeiling" | "chaseDays", min: number, max: number): number => {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return base[key];
    const clamped = Math.min(max, Math.max(min, Math.round(raw)));
    if (clamped !== raw) notes.push(`Message ${key} was ${raw}; using ${clamped}.`);
    return clamped;
  };

  const channel = value["channel"];
  const known = channel === "email" || channel === "teams" || channel === "clipboard";
  if (channel !== undefined && !known) {
    notes.push(`Unknown message channel ${JSON.stringify(channel)}; reset to "email".`);
  }

  return {
    uriCeiling: clamp("uriCeiling", 200, 8000),
    chaseDays: clamp("chaseDays", 1, 365),
    channel: known ? channel : base.channel,
  };
}

function repairBriefing(value: unknown, notes: string[]): BriefingConfig {
  const base = defaultBriefing();
  if (!isRecord(value)) {
    if (value !== undefined) notes.push("Briefing settings were not readable; reset to defaults.");
    return base;
  }

  const horizon = value["horizonDays"];
  const lastDate = value["lastDate"];

  return {
    onOpen: value["onOpen"] === true,
    // Kept verbatim when it is a string: it is a record of what happened, and
    // repairing it would make today's briefing regenerate over yesterday's.
    lastDate: typeof lastDate === "string" ? lastDate : base.lastDate,
    horizonDays:
      typeof horizon === "number" && Number.isFinite(horizon)
        ? Math.min(730, Math.max(1, Math.round(horizon)))
        : base.horizonDays,
  };
}

/**
 * Repair the effort block, and be strict about the timer.
 *
 * A malformed timer becomes **no timer**, never a repaired one. Every other
 * field here is a preference and can be nudged back into range; a timer is a
 * claim about hours worked, and inventing a plausible one from a half-written
 * `data.json` would put minutes nobody worked into a log that justifies posts.
 * Losing an unreadable session is the cheaper mistake, and it is announced.
 */
function repairEffort(value: unknown, notes: string[]): EffortConfig {
  const base = defaultEffort();
  if (!isRecord(value)) {
    if (value !== undefined) notes.push("Effort settings were not readable; reset to defaults.");
    return base;
  }

  const idle = value["idleMinutes"];
  const idleMinutes =
    typeof idle === "number" && Number.isFinite(idle)
      ? Math.min(480, Math.max(MIN_IDLE_MINUTES, Math.round(idle)))
      : base.idleMinutes;
  if (typeof idle === "number" && idle !== idleMinutes) {
    notes.push(`Effort idle threshold was ${idle} minutes; using ${idleMinutes}.`);
  }

  const costCentre = typeof value["costCentre"] === "string" ? value["costCentre"] : base.costCentre;

  const timer = readTimer(value["timer"]);
  if (value["timer"] != null && timer === null) {
    notes.push("A stored timer could not be read and was discarded. No time was recorded for it.");
  }

  return { idleMinutes, costCentre, timer };
}

/**
 * Repair the events block.
 *
 * `leadDays` is the field worth being careful with: an empty list means no lead
 * reminder ever fires for a note that declares none, which is silent failure of
 * exactly the kind §5.7 is written against. An unusable list falls back to the
 * default rather than being honoured as "none wanted" — if that is genuinely
 * wanted, the note says so with `lead_days: []`.
 */
function repairEvents(value: unknown, notes: string[]): EventsConfig {
  const base = defaultEvents();
  if (!isRecord(value)) {
    if (value !== undefined) notes.push("Event settings were not readable; reset to defaults.");
    return base;
  }

  const rawLeads = value["leadDays"];
  let leadDays = base.leadDays;
  if (Array.isArray(rawLeads)) {
    const cleaned = [
      ...new Set(
        rawLeads
          .map((entry) => (typeof entry === "number" ? Math.round(entry) : Number.NaN))
          .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 3650),
      ),
    ].sort((a, b) => b - a);
    if (cleaned.length === 0) {
      notes.push("Default lead times were unusable; reset to 30, 7 and 1 days.");
    } else {
      leadDays = cleaned;
    }
  } else if (rawLeads !== undefined) {
    notes.push("Default lead times were not a list; reset to 30, 7 and 1 days.");
  }

  const file = value["calendarFile"];
  const calendarFile =
    typeof file === "string" && file.trim() !== "" ? file.trim() : base.calendarFile;

  const check = value["checkMinutes"];
  const checkMinutes =
    typeof check === "number" && Number.isFinite(check)
      ? Math.min(1440, Math.max(5, Math.round(check)))
      : base.checkMinutes;
  if (typeof check === "number" && check !== checkMinutes) {
    notes.push(`Reminder interval was ${check} minutes; using ${checkMinutes}.`);
  }

  return {
    leadDays,
    calendarFile,
    notifyOnOpen: value["notifyOnOpen"] !== false,
    checkMinutes,
  };
}

/** A stored timer, or null when anything about it is not what it should be. */
function readTimer(value: unknown): TimerState | null {
  if (!isRecord(value)) return null;

  const status = value["status"];
  if (status !== "running" && status !== "paused") return null;

  const numbers = ["startedAt", "segmentFrom", "banked", "beat"] as const;
  for (const key of numbers) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  }

  const binding = value["binding"];
  if (!isRecord(binding)) return null;
  const text = (key: string): string =>
    typeof binding[key] === "string" ? (binding[key] as string) : "";

  return {
    status,
    startedAt: value["startedAt"] as number,
    segmentFrom: value["segmentFrom"] as number,
    banked: value["banked"] as number,
    beat: value["beat"] as number,
    binding: {
      person: text("person"),
      ref: text("ref"),
      activity: text("activity"),
      study: text("study"),
      costCentre: text("costCentre"),
      note: text("note"),
    },
  };
}

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
