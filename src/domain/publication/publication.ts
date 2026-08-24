/**
 * Publication notes (CLAUDE.md §5.4).
 *
 * Reads frontmatter into a shape the stage machine, the formatted list and the
 * impact report can reason about, and reports what it could not read rather
 * than defaulting silently. Nothing here writes anything.
 *
 * **Fields beyond §5.4.** The vault contract names what a manuscript *is*;
 * a citation also needs where it landed on the page. `volume`, `issue`,
 * `pages`, `published` and `abbreviation` are read when present and omitted
 * from the citation when absent, so a note written exactly to §5.4 still
 * formats — it just formats shorter. None of them is required by anything.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp } from "../time/dates";
import { partiesIn, type Party } from "../comms/party";

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

export function isPublicationStage(value: unknown): value is PublicationStage {
  return typeof value === "string" && (PUBLICATION_STAGES as readonly string[]).includes(value);
}

/** Stage labels, for anywhere a human reads one. */
export const STAGE_LABELS: Record<PublicationStage, string> = {
  drafting: "Drafting",
  "internal-review": "Internal review",
  submitted: "Submitted",
  "under-review": "Under review",
  revision: "Revision",
  accepted: "Accepted",
  "in-press": "In press",
  published: "Published",
  rejected: "Rejected",
  shelved: "Shelved",
};

/** A stage's label, or the raw value when the note says something unrecognised. */
export function stageLabel(stage: string): string {
  return isPublicationStage(stage) ? STAGE_LABELS[stage] : stage;
}

/**
 * Stages where nothing is awaited from anybody.
 *
 * `published`, `rejected` and `shelved` end the story; `accepted` and
 * `in-press` do not — a paper in press still has proofs, an embargo and an open
 * -access decision attached to it, and dropping it off the board is how those
 * get missed.
 */
const SETTLED: readonly string[] = ["published", "rejected", "shelved"];

/** A stage the manuscript passed through, earliest first. */
export interface PublicationHistoryEntry {
  /** Epoch ms. Entries with no readable date are dropped and reported. */
  at: number;
  to: string;
  by: string;
  /**
   * The journal at the time, when the move changed it.
   *
   * A paper rejected by one journal and sent to another is one manuscript with
   * two submissions, and `journal:` only ever holds the current one. Without
   * this, "journals where the department lands" (§5.4) can only see the last
   * stop and the resubmission count loses what it was resubmitted *to*.
   */
  journal: string;
}

export interface PublicationNote {
  path: string;
  id: string;
  title: string;
  /** As written. An unrecognised stage is kept, not coerced — see `problems`. */
  stage: string;
  journal: string;
  /** Abbreviated journal title, as most citation styles want it. Optional. */
  abbreviation: string;
  doi: string;
  pmid: string;
  /** Epoch ms, or null. */
  submitted: number | null;
  decisionDue: number | null;
  /** When it appeared. Optional; `yearOf` falls back to history (§ citation). */
  published: number | null;
  /** "Papers this facility made possible" — the number an HOD needs (§5.4). */
  scdbSupported: boolean;
  /**
   * Co-authors as §5.4 writes them, normalised so one person's several
   * spellings group together. Needed by the meeting agenda (B1), which asks
   * "what is this person holding up" across requests, threads and manuscripts.
   */
  authors: Party[];
  /** Your author position, 1-based. Null when the note does not say. */
  position: number | null;
  corresponding: boolean;
  studies: Party[];
  funding: string[];
  openAccess: boolean;
  volume: string;
  issue: string;
  pages: string;
  /** Chronological, earliest first. */
  history: PublicationHistoryEntry[];
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field holding one string or a list of them. Blanks dropped. */
function strings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(str).filter((entry) => entry !== "");
}

function parseHistory(raw: unknown, problems: string[]): PublicationHistoryEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("`history` is not a list, so the manuscript's timeline cannot be read.");
    return [];
  }

  const entries: PublicationHistoryEntry[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`history[${index}] is not a mapping and was ignored.`);
      return;
    }
    const at = parseTimestamp(entry["at"]);
    const to = str(entry["to"]);
    if (at === null) {
      problems.push(`history[${index}] has no readable \`at\` date and was ignored.`);
      return;
    }
    if (to === "") {
      problems.push(`history[${index}] has no \`to\` stage and was ignored.`);
      return;
    }
    entries.push({ at, to, by: str(entry["by"]), journal: str(entry["journal"]) });
  });

  // Frontmatter is hand-editable, so the list may not be in order. Sorting on
  // read means nothing downstream has to wonder.
  return entries.sort((a, b) => a.at - b.at);
}

export function parsePublication(
  path: string,
  raw: Record<string, unknown>,
): PublicationNote {
  const problems: string[] = [];

  const stage = str(raw["stage"]);
  if (stage !== "" && !isPublicationStage(stage)) {
    problems.push(`Stage "${stage}" is not one of the publication stages in §5.4.`);
  }

  const decisionDue = parseTimestamp(raw["decision_due"]);
  if (raw["decision_due"] !== undefined && decisionDue === null) {
    problems.push("`decision_due` is not a date the plugin can read.");
  }

  // `author_position` first, because Obsidian's metadata cache overwrites
  // `position` with the frontmatter block's own line range — see
  // `data/noteIndex.cleanFrontmatter`. §5.4 names `position`, so it is still
  // read: that path works wherever the YAML is parsed directly, and dropping
  // it would break the fixtures that document the contract.
  const raw_position = raw["author_position"] ?? raw["position"];
  const position = num(raw_position);
  if (raw_position !== undefined && position === null) {
    problems.push("`position` is not a number.");
  }

  return {
    path,
    id: str(raw["id"]),
    title: str(raw["title"]),
    stage,
    journal: str(raw["journal"]),
    abbreviation: str(raw["abbreviation"]),
    doi: str(raw["doi"]),
    pmid: str(raw["pmid"]),
    submitted: parseTimestamp(raw["submitted"]),
    decisionDue,
    published: parseTimestamp(raw["published"]),
    scdbSupported: raw["scdb_supported"] === true,
    authors: partiesIn(raw["authors"]),
    position,
    corresponding: raw["corresponding"] === true,
    studies: partiesIn(raw["studies"]),
    funding: strings(raw["funding"]),
    openAccess: raw["open_access"] === true,
    volume: str(raw["volume"]),
    issue: str(raw["issue"]),
    pages: str(raw["pages"]),
    history: parseHistory(raw["history"], problems),
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
