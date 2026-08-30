/**
 * Presentation vocabulary (CLAUDE.md §6).
 *
 * In `domain/` rather than `ui/` because the static HTML export needs the same
 * words as the screen: a board that reads "Overdue" in Obsidian and "breached"
 * in the exported file is two vocabularies pretending to be one.
 *
 * Two rules from the design language live here:
 *
 *  - **Never colour alone.** Every state carries a glyph and a label as well as
 *    a colour class, so the board reads correctly for a colour-blind reader and
 *    in a theme that overrides our palette.
 *  - **Durations are human.** One formatter, imported everywhere.
 */

import type { ImpactVerdict } from "../policy/impact";
import type { MilestoneState } from "../project/milestones";
import type { ReviewState } from "../policy/register";
import type { SlaState } from "../request/dwell";
import { formatDuration } from "../time/dates";

export interface StatePresentation {
  label: string;
  /** Text glyph, not an icon font — it survives copy-paste into an export. */
  glyph: string;
  className: string;
}

const STATES: Record<SlaState, StatePresentation> = {
  breached: { label: "Overdue", glyph: "!", className: "scdb-state--overdue" },
  "at-risk": { label: "At risk", glyph: "~", className: "scdb-state--at-risk" },
  "on-track": { label: "On track", glyph: "·", className: "scdb-state--on-track" },
  "no-target": { label: "No target", glyph: "–", className: "scdb-state--none" },
};

export function presentState(state: SlaState): StatePresentation {
  return STATES[state];
}

/**
 * Impact-map verdicts (§7 C1), on the same four colours as everything else.
 *
 * Deliberately not a fifth and sixth colour. §6 asks for **one** semantic
 * palette across the plugin, so a governance verdict borrows the meaning
 * already established: a dependant resting on a clause that has vanished is
 * the same red as a breached SLA, and one that has been cleared is the same
 * quiet green as on-track.
 */
const VERDICTS: Record<ImpactVerdict, StatePresentation> = {
  "clause-gone": { label: "Clause gone", glyph: "✕", className: "scdb-state--overdue" },
  affected: { label: "Affected", glyph: "●", className: "scdb-state--at-risk" },
  // Accent rather than amber: "we cannot tell" is a job for a person, which is
  // the same thing `blocked` means everywhere else in the plugin.
  review: { label: "Review", glyph: "?", className: "scdb-state--blocked" },
  clear: { label: "Clear", glyph: "○", className: "scdb-state--on-track" },
};

export function presentVerdict(verdict: ImpactVerdict): StatePresentation {
  return VERDICTS[verdict];
}

/** Where a policy stands against its own review date (§7 C1). */
const REVIEWS: Record<ReviewState, StatePresentation> = {
  overdue: { label: "Review overdue", glyph: "!", className: "scdb-state--overdue" },
  "due-soon": { label: "Review due", glyph: "~", className: "scdb-state--at-risk" },
  scheduled: { label: "Scheduled", glyph: "·", className: "scdb-state--on-track" },
  unset: { label: "No review date", glyph: "–", className: "scdb-state--none" },
};

export function presentReview(state: ReviewState): StatePresentation {
  return REVIEWS[state];
}

/**
 * Milestone states (§5.15), on the same palette as everything else.
 *
 * `blocked` reuses the class the request boards already use for "a person has
 * to do something before this can move" — which is exactly what a milestone
 * waiting on a predecessor means. §6 asks for one semantic palette; a sixth
 * colour for a sixth concept is how a palette stops meaning anything.
 */
const MILESTONES: Record<MilestoneState, StatePresentation> = {
  overdue: { label: "Overdue", glyph: "!", className: "scdb-state--overdue" },
  "due-soon": { label: "Due soon", glyph: "~", className: "scdb-state--at-risk" },
  blocked: { label: "Blocked", glyph: "⋯", className: "scdb-state--blocked" },
  open: { label: "Open", glyph: "·", className: "scdb-state--none" },
  done: { label: "Landed", glyph: "✓", className: "scdb-state--on-track" },
};

export function presentMilestone(state: MilestoneState): StatePresentation {
  return MILESTONES[state];
}

/** "23 days", or an em dash when there is nothing to show. */
export function duration(ms: number | null): string {
  return ms === null ? "—" : formatDuration(ms);
}

/** `[[Dr A Tan]]` reads as "Dr A Tan" in a table; the link stays in the note. */
export function displayName(value: string | null): string {
  if (value === null || value === "") return "—";
  const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim());
  return match ? (match[2] ?? match[1]!).trim() : value;
}

/** "5 requests", "1 request". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
