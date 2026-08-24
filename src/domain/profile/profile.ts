/**
 * Profile notes — the CV's source data (CLAUDE.md §5.9, §7 B7).
 *
 * §5.9 states the design rule this module exists to serve: *the CV is not a
 * document you maintain; it is a query over these*. One note per item, added
 * when it happens, ten seconds each. The payoff is that a CV, an appraisal
 * return and a grant biosketch stop being an annual archaeology exercise.
 *
 * The corollary, from §7 B7, is that the templates own **layout only**. So
 * everything a CV line needs is read here, and nothing about how it will be
 * printed appears in this file.
 *
 * Six note types, each with its own fields, sharing three things: a title, a
 * period, and the year the item sorts under. They are parsed leniently and
 * report what they could not read rather than throwing — a profile note is
 * something you typed in ten seconds between meetings, and a CV that refuses to
 * build because one `period` is malformed is a CV you will stop maintaining.
 *
 * Pure module: no Obsidian, no Node.
 */

import { partiesIn, type Party } from "../comms/party";
import { parseTimestamp, toVaultDate } from "../time/dates";

export const PROFILE_TYPES = [
  "grant",
  "service",
  "teaching",
  "supervision",
  "presentation",
  "award",
] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export function isProfileType(value: unknown): value is ProfileType {
  return typeof value === "string" && (PROFILE_TYPES as readonly string[]).includes(value);
}

/**
 * When an item ran.
 *
 * Held as the text the note carries — `2024`, `2024-03`, `2024-03-01` are all
 * legitimate precisions and flattening them to a full date would invent a day
 * the writer did not claim. `startYear` is what sorting uses; `text` is what a
 * CV line prints.
 */
export interface Period {
  /** As written, normalised: "", "2024", "2024-03" or "2024-03-01". */
  from: string;
  to: string;
  /** True when the item has a start and no end: "2024–present". */
  ongoing: boolean;
  startYear: number | null;
  endYear: number | null;
}

export const EMPTY_PERIOD: Period = {
  from: "",
  to: "",
  ongoing: false,
  startYear: null,
  endYear: null,
};

interface Base {
  path: string;
  title: string;
  period: Period;
  /**
   * The year the item files under on a reverse-chronological CV.
   *
   * Its start, not its end: that is how every CV is ordered, and it keeps a
   * five-year grant above a one-day talk that happened in the same month.
   */
  year: number | null;
  /** Free-text note from the body-less part of the contract. Optional. */
  note: string;
  /** What could not be read. Surfaced on the CV preview, never swallowed. */
  problems: string[];
}

export interface GrantNote extends Base {
  type: "grant";
  /** PI, co-I, collaborator — as written; no closed vocabulary in §5.9. */
  role: string;
  agency: string;
  ref: string;
  amount: number | null;
  currency: string;
  status: string;
  studies: Party[];
}

export interface ServiceNote extends Base {
  type: "service";
  organisation: string;
  position: string;
  /** institutional | national | international, as written. */
  scope: string;
}

export interface TeachingNote extends Base {
  type: "teaching";
  institution: string;
  role: string;
  level: string;
  hours: number | null;
}

export interface SupervisionNote extends Base {
  type: "supervision";
  trainee: string;
  degree: string;
  role: string;
  outcome: string;
}

export interface PresentationNote extends Base {
  type: "presentation";
  meeting: string;
  location: string;
  /** `YYYY-MM-DD`, or "" when the note gives only a period. */
  date: string;
  invited: boolean;
  /** oral | poster, as written. */
  format: string;
}

export interface AwardNote extends Base {
  type: "award";
  body: string;
}

export type ProfileNote =
  | GrantNote
  | ServiceNote
  | TeachingNote
  | SupervisionNote
  | PresentationNote
  | AwardNote;

/* ------------------------------------------------------------- reading -- */

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date) return toVaultDate(value.getTime());
  return "";
}

function first(frontmatter: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = str(frontmatter[key]);
    if (value !== "") return value;
  }
  return "";
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "y"].includes(value.trim().toLowerCase());
  return false;
}

/**
 * A money or hours figure.
 *
 * Separators are stripped because people write `250,000` and `1 200` — but a
 * currency symbol is not: `$250,000` in an `amount` field means the currency
 * was recorded in the wrong place, and silently discarding the `$` would hide
 * that from someone reconciling a biosketch against an award letter.
 */
function amountOf(value: unknown, problems: string[], label: string): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = str(value);
  if (text === "") return null;
  const cleaned = text.replace(/[,_\s]/g, "");
  const parsed = Number(cleaned);
  if (Number.isFinite(parsed)) return parsed;
  problems.push(`\`${label}: ${text}\` is not a number, so it is shown as written.`);
  return null;
}

const YEAR_ONLY = /^\d{4}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** "2024-2027", "2024–2027", "2024 to 2027", "2024-present". */
const RANGE = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\s*(?:-|–|—|to)\s*(present|ongoing|current|\d{4}(?:-\d{2}(?:-\d{2})?)?)$/i;

/** One end of a period, at whatever precision the note wrote it. */
function pointOf(value: unknown): string {
  const text = str(value);
  if (text === "") return "";
  if (YEAR_ONLY.test(text) || YEAR_MONTH.test(text) || FULL_DATE.test(text)) return text;
  const stamp = parseTimestamp(text);
  return stamp === null ? text : toVaultDate(stamp);
}

function yearOfPoint(point: string): number | null {
  const year = Number(point.slice(0, 4));
  return Number.isInteger(year) && year > 1000 ? year : null;
}

const OPEN_ENDED = new Set(["present", "ongoing", "current"]);

/**
 * Read the period from whichever keys the note used.
 *
 * §5.9 says "period" for four of the six types, "date" for a presentation and
 * "year" for an award, and people write `period: 2024-2027` as often as they
 * write `from:`/`to:`. All of them mean the same thing to a CV, so all of them
 * are read — rather than making the writer remember which type wanted which key.
 */
export function readPeriod(frontmatter: Record<string, unknown>): Period {
  const raw = frontmatter["period"];

  if (raw !== undefined && raw !== null && typeof raw === "object" && !(raw instanceof Date)) {
    const record = raw as Record<string, unknown>;
    return periodOf(pointOf(record["from"] ?? record["start"]), str(record["to"] ?? record["end"]));
  }

  const text = str(raw);
  const range = RANGE.exec(text);
  if (range) return periodOf(range[1]!, range[2]!);
  if (text !== "") return periodOf(pointOf(text), "");

  const from = pointOf(frontmatter["from"] ?? frontmatter["start"] ?? frontmatter["date"]);
  const to = str(frontmatter["to"] ?? frontmatter["end"]);
  if (from !== "" || to !== "") return periodOf(from, to);

  const year = str(frontmatter["year"]);
  return year === "" ? { ...EMPTY_PERIOD } : periodOf(year, "");
}

function periodOf(from: string, toRaw: string): Period {
  // `ongoing` is only ever what the note *said* — `to: present`, or
  // `period: 2024-present`. A single value is a point in time, not an open
  // range: `year: 2025` on an award, or a one-year committee term, would
  // otherwise print as "2025–present", which is a claim about today that
  // nothing in the note supports. If you mean present, write present.
  const ongoing = OPEN_ENDED.has(toRaw.trim().toLowerCase());
  const to = ongoing ? "" : pointOf(toRaw);
  return {
    from,
    to,
    ongoing,
    startYear: yearOfPoint(from),
    endYear: yearOfPoint(to),
  };
}

/** "2024–2027", "2024–present", "2026". Never a bare dash. */
export function periodText(period: Period): string {
  if (period.from === "" && period.to === "") return "";
  if (period.from === "") return period.to;
  if (period.to === period.from) return period.from;
  if (period.to === "") return period.ongoing ? `${period.from}–present` : period.from;
  return `${period.from}–${period.to}`;
}

/**
 * Read a profile note.
 *
 * Returns null when the note is not one of the six types, so a caller can hand
 * over every note in the folder without filtering first.
 */
export function parseProfileNote(
  path: string,
  frontmatter: Record<string, unknown>,
): ProfileNote | null {
  const type = str(frontmatter["type"]);
  if (!isProfileType(type)) return null;

  const problems: string[] = [];
  const period = readPeriod(frontmatter);
  const title = first(frontmatter, "title", "course", "committee", "role", "trainee");

  if (title === "") {
    problems.push("This note has no `title`, so it appears on the CV as “(untitled)”.");
  }
  if (period.startYear === null && period.endYear === null) {
    problems.push("No readable `period`, `date` or `year`, so this sorts to the end of its section.");
  }

  const base: Base = {
    path,
    title: title === "" ? "(untitled)" : title,
    period,
    year: period.startYear ?? period.endYear,
    note: str(frontmatter["note"]),
    problems,
  };

  switch (type) {
    case "grant":
      return {
        ...base,
        type,
        role: str(frontmatter["role"]),
        agency: first(frontmatter, "agency", "funder"),
        ref: first(frontmatter, "ref", "reference", "grant_ref"),
        amount: amountOf(frontmatter["amount"], problems, "amount"),
        currency: str(frontmatter["currency"]),
        status: str(frontmatter["status"]),
        studies: partiesIn(frontmatter["studies"] ?? frontmatter["study"]),
      };
    case "service":
      return {
        ...base,
        type,
        organisation: first(frontmatter, "organisation", "organization", "body"),
        // `role` first: Obsidian's metadata cache overwrites `position` with
        // the frontmatter block's own line range, so a `position:` a user
        // typed never reaches us (see `data/noteIndex.cleanFrontmatter`).
        // `position` is still read, because it works when the YAML is parsed
        // directly and because §5.9 names it.
        position: first(frontmatter, "role", "position"),
        scope: str(frontmatter["scope"]),
      };
    case "teaching":
      return {
        ...base,
        type,
        institution: str(frontmatter["institution"]),
        role: str(frontmatter["role"]),
        level: str(frontmatter["level"]),
        hours: amountOf(frontmatter["hours"], problems, "hours"),
      };
    case "supervision":
      return {
        ...base,
        type,
        trainee: str(frontmatter["trainee"]),
        degree: str(frontmatter["degree"]),
        role: str(frontmatter["role"]),
        outcome: str(frontmatter["outcome"]),
      };
    case "presentation":
      return {
        ...base,
        type,
        meeting: first(frontmatter, "meeting", "conference"),
        location: str(frontmatter["location"]),
        date: pointOf(frontmatter["date"]),
        invited: bool(frontmatter["invited"]),
        format: first(frontmatter, "format", "presentation_type"),
      };
    case "award":
      return { ...base, type, body: first(frontmatter, "body", "awarded_by", "organisation") };
  }
}

/**
 * Reverse chronological, the way every CV is read.
 *
 * By start year, not end: a five-year grant belongs above a talk given in the
 * middle of it. Undated items sort last rather than first — an item with no
 * year is usually one somebody has not finished typing, and putting it at the
 * top of a section is how it ends up pasted into a grant application.
 */
export function byRecency(a: ProfileNote, b: ProfileNote): number {
  if (a.year !== b.year) {
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return b.year - a.year;
  }
  const end = (b.period.endYear ?? b.year ?? 0) - (a.period.endYear ?? a.year ?? 0);
  if (end !== 0) return end;
  return a.title.localeCompare(b.title);
}

export function profilesOfType<T extends ProfileType>(
  notes: readonly ProfileNote[],
  type: T,
): Extract<ProfileNote, { type: T }>[] {
  return notes
    .filter((note): note is Extract<ProfileNote, { type: T }> => note.type === type)
    .sort(byRecency);
}
