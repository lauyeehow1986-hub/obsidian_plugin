/**
 * Publication notes (CLAUDE.md §5.4).
 *
 * A reader only. The stage machine, decision-due reminders, the formatted list
 * and the impact report are B5; what the cockpit needs now is "which
 * manuscripts are in flight and which decision is overdue", and that is a
 * question about frontmatter the vault contract already specifies.
 *
 * Reading it now rather than waiting for B5 costs nothing and means the note
 * type earns its place from day one — the same argument §7 C2 makes for the
 * variable catalogue.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp } from "../time/dates";

export const PUBLICATION_TYPE = "publication";

export const PUBLICATION_STAGES = [
  "drafting",
  "internal-review",
  "submitted",
  "under-review",
  "revision",
  "accepted",
  "in-press",
  "published",
  "rejected",
  "shelved",
] as const;
export type PublicationStage = (typeof PUBLICATION_STAGES)[number];

/**
 * Stages where nothing is awaited from anybody.
 *
 * `published`, `rejected` and `shelved` end the story; `accepted` and
 * `in-press` do not — a paper in press still has proofs, an embargo and an open
 * -access decision attached to it, and dropping it off the board is how those
 * get missed.
 */
const SETTLED: readonly string[] = ["published", "rejected", "shelved"];

export interface PublicationNote {
  path: string;
  id: string;
  title: string;
  /** As written. An unrecognised stage is kept, not coerced — see `problems`. */
  stage: string;
  journal: string;
  /** Epoch ms, or null. */
  submitted: number | null;
  decisionDue: number | null;
  /** "Papers this facility made possible" — the number an HOD needs (§5.4). */
  scdbSupported: boolean;
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parsePublication(
  path: string,
  raw: Record<string, unknown>,
): PublicationNote {
  const problems: string[] = [];

  const stage = str(raw["stage"]);
  if (stage !== "" && !(PUBLICATION_STAGES as readonly string[]).includes(stage)) {
    problems.push(`Stage "${stage}" is not one of the publication stages in §5.4.`);
  }

  const decisionDue = parseTimestamp(raw["decision_due"]);
  if (raw["decision_due"] !== undefined && decisionDue === null) {
    problems.push("`decision_due` is not a date the plugin can read.");
  }

  return {
    path,
    id: str(raw["id"]),
    title: str(raw["title"]),
    stage,
    journal: str(raw["journal"]),
    submitted: parseTimestamp(raw["submitted"]),
    decisionDue,
    scdbSupported: raw["scdb_supported"] === true,
    problems,
  };
}

/** True while the manuscript still needs something from someone. */
export function inFlight(publication: PublicationNote): boolean {
  return !SETTLED.includes(publication.stage);
}

/**
 * In-flight manuscripts, most urgent first.
 *
 * Ordered by decision due date, with undated ones last: a paper with a decision
 * expected next week outranks one that has been in drafting for a year, and a
 * paper with no date at all is not urgent, only unrecorded.
 */
export function publicationsInFlight(
  publications: readonly PublicationNote[],
): PublicationNote[] {
  return publications
    .filter(inFlight)
    .sort((a, b) => (a.decisionDue ?? Infinity) - (b.decisionDue ?? Infinity));
}
