/**
 * Settings schema. Pure — no Obsidian imports (CLAUDE.md §4).
 *
 * Every schema change bumps CURRENT_SETTINGS_VERSION and adds a migration step.
 * An upgrade must never lose settings (CLAUDE.md §10).
 */

import type { TimerState } from "../effort/timer";

export const CURRENT_SETTINGS_VERSION = 5;

/** The three hats. Mode is the organising metaphor, not a cosmetic filter (§7 A3). */
export const MODES = ["biostat", "hod", "research-core"] as const;
export type Mode = (typeof MODES)[number];

export const FOLDER_KEYS = [
  "inbox",
  "requests",
  "studies",
  "people",
  "policies",
  "scripts",
  "events",
  "meetings",
  "correspondence",
  "time",
  "audit",
  "profile",
  "publications",
  "catalogue",
  "forms",
  "diagrams",
  "dashboards",
  "briefings",
  "apps",
  "runs",
  "exports",
  "config",
] as const;
export type FolderKey = (typeof FOLDER_KEYS)[number];

export interface ScdbSettings {
  schemaVersion: number;
  /** Recorded as `actor` in the audit ledger and effort log. */
  actor: string;
  mode: Mode;
  folders: Record<FolderKey, string>;
  /** Core Bases is a progressive enhancement; "auto" uses it when available. */
  bases: "auto" | "off";
  /**
   * Whether the boards narrow to the hat being worn (§7 A3).
   *
   * "all" is a real setting rather than a hidden debug switch: a filter that
   * cannot be turned off is a filter that hides an overdue request from you.
   */
  hatFilter: "mode" | "all";
  backup: BackupConfig;
  comms: CommsConfig;
  briefing: BriefingConfig;
  effort: EffortConfig;
  /** Unrecognised keys are preserved verbatim — see rule 8, never destroy data. */
  [extra: string]: unknown;
}

/**
 * Composing messages (§5.11) and ageing what was composed (§5.10).
 *
 * Nothing here sends anything or reaches a network. The plugin builds a URI and
 * hands it to the OS shell; the user presses send.
 */
export interface CommsConfig {
  /**
   * Longest URI we will hand to a protocol handler.
   *
   * Handlers truncate somewhere around 2,000 characters and the exact figure
   * varies by handler and Windows build — §11 lists measuring it on the target
   * machine as an open question. Over this, the draft goes to the clipboard
   * whole rather than being launched cut off.
   */
  uriCeiling: number;
  /** Days before unanswered outreach is worth chasing. */
  chaseDays: number;
  /** What the composer opens by default. Clipboard is always offered too. */
  channel: "email" | "teams" | "clipboard";
}

export interface BriefingConfig {
  /** Generate on the first vault open of the day. Off until you ask for it. */
  onOpen: boolean;
  /** `YYYY-MM-DD` of the last one written; empty means never. */
  lastDate: string;
  /** How far ahead the "coming up" section looks. */
  horizonDays: number;
}

/**
 * The effort timer and what it writes (§7 B2).
 *
 * The running timer lives here rather than in a file of its own because it has
 * to survive a crash, and `data.json` is already written on every settings
 * change. Persisting it is the whole crash-safety story: the alternative is a
 * timer that exists only in memory, which is the one place a crash reaches.
 */
export interface EffortConfig {
  /**
   * Minutes of silence before the timer asks what happened.
   *
   * What this actually detects is the machine sleeping or Obsidian not running
   * — a missed heartbeat — **not** the user staring out of the window. Real
   * user-idle detection needs Electron APIs a plugin cannot reach, and claiming
   * to measure attention would be a lie the numbers could not support.
   */
  idleMinutes: number;
  /** Pre-filled on new entries, so chargeback coding is not retyped daily. */
  costCentre: string;
  /** The running timer, or null. Never invented on load; see the migration. */
  timer: TimerState | null;
}

export function defaultEffort(): EffortConfig {
  return { idleMinutes: 10, costCentre: "", timer: null };
}

export function defaultComms(): CommsConfig {
  return { uriCeiling: 1800, chaseDays: 7, channel: "email" };
}

export function defaultBriefing(): BriefingConfig {
  // `onOpen` is false on a fresh install for the same reason nothing else is
  // enabled (rule 3): a plugin that writes a note into your vault the first
  // time you open it has made a decision that was yours to make.
  return { onOpen: false, lastDate: "", horizonDays: 60 };
}

/**
 * Encrypted snapshots (§7 A4).
 *
 * `destination` is empty until the user sets it, and every backup command
 * refuses until then. Guessing a folder would mean the plugin writing the whole
 * vault to a path nobody chose — the opposite of rule 3's "nothing is enabled
 * on first install", applied to the filesystem rather than the network.
 *
 * The passphrase is **not here and never will be**. It is asked for on every
 * operation and held only for the length of one call.
 */
export interface BackupConfig {
  /** Absolute path to a folder OUTSIDE the vault. Empty means not configured. */
  destination: string;
  /** How many snapshots to keep. Only files this plugin named are ever removed. */
  keep: number;
  /** Days before the status bar starts saying the backup is old. */
  intervalDays: number;
  /** ISO 8601 UTC of the last successful snapshot; empty means never. */
  lastAt: string;
  /** File name of the last snapshot, for the diagnostics report. No path. */
  lastName: string;
}

export function defaultBackup(): BackupConfig {
  return { destination: "", keep: 7, intervalDays: 7, lastAt: "", lastName: "" };
}

export const DEFAULT_FOLDERS: Record<FolderKey, string> = {
  inbox: "00 Inbox",
  requests: "10 Requests",
  studies: "20 Studies",
  people: "30 People",
  policies: "40 Policies",
  scripts: "50 Scripts",
  events: "60 Events",
  meetings: "70 Meetings",
  correspondence: "75 Correspondence",
  time: "80 Time",
  audit: "82 Audit",
  profile: "84 Profile",
  publications: "85 Publications",
  catalogue: "87 Catalogue",
  forms: "88 Forms",
  diagrams: "89 Diagrams",
  dashboards: "90 Dashboards",
  // B1's daily briefing has to land somewhere, and §5 names no folder for it.
  // Under Dashboards rather than beside them: a briefing is a dated record of
  // one morning, not a saved view, and a year of them would swamp the folder
  // the saved views live in.
  briefings: "90 Dashboards/Briefings",
  apps: "92 Apps",
  runs: "94 Runs",
  exports: "95 Exports",
  config: "_config",
};

export function defaultSettings(): ScdbSettings {
  return {
    schemaVersion: CURRENT_SETTINGS_VERSION,
    actor: "",
    mode: "hod",
    folders: { ...DEFAULT_FOLDERS },
    bases: "auto",
    hatFilter: "mode",
    backup: defaultBackup(),
    comms: defaultComms(),
    briefing: defaultBriefing(),
    effort: defaultEffort(),
  };
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}
