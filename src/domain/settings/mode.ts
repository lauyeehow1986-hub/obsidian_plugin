/**
 * The three hats (CLAUDE.md §1, §7 A3).
 *
 * Mode is the organising metaphor of the whole plugin, not a cosmetic filter:
 * it decides what the boards show, which activity category the timer defaults
 * to (B2), what quick capture creates (B1), and which dashboard opens. Putting
 * the vocabulary here — pure, testable, Obsidian-free — means the status bar,
 * the settings tab, the intake dialog and the query engine all name the hats
 * the same way.
 *
 * Pure module: no Obsidian, no Node.
 */

import { MODES, type Mode } from "./schema";

export interface ModeInfo {
  id: Mode;
  /** What the status bar has room for. */
  short: string;
  /** The role, spelled out, for tooltips and settings. */
  label: string;
  /**
   * A text glyph, because §6 forbids status by colour alone and the status bar
   * is the one place in the plugin with no room for a word of explanation.
   */
  glyph: string;
  /** One line on what this hat covers, for the tooltip and the settings tab. */
  blurb: string;
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  biostat: {
    id: "biostat",
    short: "Biostat",
    label: "Biostatistician",
    glyph: "∑",
    blurb: "Study design, sample size, analysis planning and script provenance.",
  },
  hod: {
    id: "hod",
    short: "HOD",
    label: "Head of SCDB",
    glyph: "▤",
    blurb: "Intake, triage, extraction and delivery of data requests.",
  },
  "research-core": {
    id: "research-core",
    short: "Research Core",
    label: "Assistant Director of Research",
    glyph: "◈",
    blurb: "Research data governance and enablement across the institution.",
  },
};

export function modeInfo(mode: Mode): ModeInfo {
  return MODE_INFO[mode];
}

/** Every hat, in the order the hotkeys and the status-bar cycle follow. */
export function allModes(): ModeInfo[] {
  return MODES.map((mode) => MODE_INFO[mode]);
}

/** The next hat in the cycle, wrapping. Clicking the status bar calls this. */
export function nextMode(mode: Mode): Mode {
  const index = MODES.indexOf(mode);
  return MODES[(index + 1) % MODES.length]!;
}

/**
 * Does a note belong to the hat currently being worn?
 *
 * A note with **no** `hat` matches every mode, deliberately. Unattributed work
 * is still work, and the alternative — hiding it under all three hats until
 * somebody classifies it — turns a filter into a way to lose a request. The
 * boards mark these rather than hide them.
 *
 * Matching is case-insensitive and trims, because `hat` is hand-typed
 * frontmatter. An unrecognised value (a typo, a hat we do not know) matches
 * nothing, so it shows up as hidden and is findable rather than silently
 * folded into whichever mode happens to be on.
 */
export function matchesMode(hat: string | null | undefined, mode: Mode): boolean {
  const value = (hat ?? "").trim().toLowerCase();
  return value === "" || value === mode;
}

/** True when the note carries no hat at all — shown everywhere, flagged. */
export function unhatted(hat: string | null | undefined): boolean {
  return (hat ?? "").trim() === "";
}
