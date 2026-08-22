/**
 * Settings schema. Pure — no Obsidian imports (CLAUDE.md §4).
 *
 * Every schema change bumps CURRENT_SETTINGS_VERSION and adds a migration step.
 * An upgrade must never lose settings (CLAUDE.md §10).
 */

export const CURRENT_SETTINGS_VERSION = 2;

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
  /** Unrecognised keys are preserved verbatim — see rule 8, never destroy data. */
  [extra: string]: unknown;
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
  };
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}
