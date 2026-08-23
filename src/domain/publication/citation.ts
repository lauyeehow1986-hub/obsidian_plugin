/**
 * Formatted publication lists (CLAUDE.md §5.4, §7 B5).
 *
 * §5.4 asks for "a formatted publication list grouped by year in a configurable
 * citation format (default Vancouver)". The hard part is not the punctuation;
 * it is that a vault names authors the way a person types them —
 * `[[Dr A Tan]]`, `[[30 People/Prof Siew Lim|Siew]]` — and a citation wants
 * "Tan A" and "Lim S".
 *
 * That conversion is a **guess**, and it is treated as one. `authorName`
 * reports how confident it is, `formatList` can be asked for the uncertain ones,
 * and a note may override the whole question by giving `authors_cite:` verbatim.
 * A CV that silently renames a collaborator is worse than one that asks.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { Party } from "../comms/party";
import type { PublicationNote } from "./publication";

export const CITATION_FORMATS = ["vancouver", "apa"] as const;
export type CitationFormat = (typeof CITATION_FORMATS)[number];

export function isCitationFormat(value: unknown): value is CitationFormat {
  return typeof value === "string" && (CITATION_FORMATS as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------- names -- */

/**
 * Titles that sit in front of a name in a clinical vault.
 *
 * Lower-cased and stripped of punctuation before matching, so "Dr.", "dr" and
 * "DR" are one entry. `a/prof` and `assoc` cover the two ways the same rank is
 * written locally.
 */
const HONORIFICS = new Set([
  "dr",
  "prof",
  "professor",
  "assoc",
  "associate",
  "adj",
  "adjunct",
  "a/prof",
  "asst",
  "assistant",
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "sr",
  "sister",
]);

/** Suffixes that are not part of a surname. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "mbbs", "frcp", "facc"]);

export interface AuthorName {
  /** The vault's spelling, for showing next to a guess. */
  raw: string;
  surname: string;
  /** Initials with no dots or spaces: "AB". Empty when the name has one word. */
  initials: string;
  /**
   * Given names in full, where the note wrote them out. Empty when the note
   * only ever had initials, which is the common case.
   */
  given: string;
  /**
   * False when the split is a guess worth showing the user — a single-word name
   * with no surname to find, or a name whose given part is a whole word rather
   * than an initial, where "Siew Lim" could as easily be surname-first.
   */
  confident: boolean;
}

const PUNCT = /[.,]/g;

/**
 * Split a vault name into surname and initials.
 *
 * The rule is Western order — honorifics, then given names, then surname —
 * because that is how the vault contract's own examples are written
 * (`[[Dr A Tan]]`, §5.1). Names that do not follow it are reported as
 * unconfident rather than mangled quietly.
 */
export function authorName(party: Party): AuthorName {
  const raw = party.name;
  const words = raw
    .split(/\s+/)
    .map((word) => word.replace(PUNCT, "").trim())
    .filter((word) => word !== "");

  // Honorifics only lead. "Dr" appearing later is somebody's actual name.
  let start = 0;
  while (start < words.length - 1 && HONORIFICS.has(words[start]!.toLowerCase())) start += 1;

  let end = words.length;
  while (end > start + 1 && SUFFIXES.has(words[end - 1]!.toLowerCase())) end -= 1;

  const parts = words.slice(start, end);
  if (parts.length === 0) return { raw, surname: raw, initials: "", given: "", confident: false };
  if (parts.length === 1) {
    // One word: it is the whole name. "Owner", "IT helpdesk" as a placeholder.
    return { raw, surname: parts[0]!, initials: "", given: "", confident: false };
  }

  const surname = parts[parts.length - 1]!;
  const fore = parts.slice(0, -1);
  const initials = fore.map((word) => word[0]!.toUpperCase()).join("");
  const spelled = fore.filter((word) => word.length > 1);

  return {
    raw,
    surname,
    initials,
    given: spelled.join(" "),
    // A name written out in full is ambiguous about which end the surname is.
    // A name written "A Tan" is not — that is the vault contract's own shape.
    confident: spelled.length === 0,
  };
}

/** "Tan A" — Vancouver, and the same shape most biomedical styles want. */
export function vancouverName(name: AuthorName): string {
  return name.initials === "" ? name.surname : `${name.surname} ${name.initials}`;
}

/** "Tan, A." — APA. */
export function apaName(name: AuthorName): string {
  if (name.initials === "") return name.surname;
  const dotted = name.initials.split("").map((letter) => `${letter}.`).join(" ");
  return `${name.surname}, ${dotted}`;
}

/**
 * The author list, in the style's own truncation rule.
 *
 * Vancouver lists the first six then "et al."; APA lists up to twenty and
 * elides the middle. Both are the published rule rather than a preference, so
 * they are not configurable.
 */
function authorList(names: readonly AuthorName[], format: CitationFormat): string {
  if (names.length === 0) return "";
  if (format === "apa") {
    const written = names.map(apaName);
    if (written.length <= 2) return written.join(" & ");
    if (written.length <= 20) {
      return `${written.slice(0, -1).join(", ")}, & ${written[written.length - 1]}`;
    }
    return `${written.slice(0, 19).join(", ")}, … ${written[written.length - 1]}`;
  }
  const written = names.map(vancouverName);
  return written.length > 6 ? `${written.slice(0, 6).join(", ")}, et al.` : written.join(", ");
}

/* ------------------------------------------------------------------ year -- */

export interface PublicationYear {
  /** Null when nothing on the note dates it at all. */
  year: number | null;
  /**
   * Which field the year came from. Shown in the list when it is not
   * `published`, because "grouped by year" quietly meaning "year we sent it"
   * for half the entries is the kind of thing that gets noticed in a viva.
   */
  from: "published" | "history" | "submitted" | "none";
}

const APPEARED: readonly string[] = ["published", "in-press", "accepted"];

/**
 * When a manuscript counts as belonging to a year.
 *
 * In order: the `published` date, then the first history entry that put it in
 * print, then the submission date. A paper still under review has no
 * publication year and saying so is the honest answer.
 */
export function yearOf(publication: PublicationNote): PublicationYear {
  if (publication.published !== null) {
    return { year: new Date(publication.published).getUTCFullYear(), from: "published" };
  }
  const appeared = publication.history.find((entry) => APPEARED.includes(entry.to));
  if (appeared) return { year: new Date(appeared.at).getUTCFullYear(), from: "history" };
  if (publication.submitted !== null) {
    return { year: new Date(publication.submitted).getUTCFullYear(), from: "submitted" };
  }
  return { year: null, from: "none" };
}

/* ------------------------------------------------------------- citations -- */

export interface Citation {
  publication: PublicationNote;
  /** The formatted reference, ready to paste. */
  text: string;
  year: PublicationYear;
  /** Author names the split was not sure about. Empty when all were clean. */
  uncertain: AuthorName[];
}

function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part.trim() !== "").join(" ");
}

/** End a sentence without doubling a stop APA's dotted initials already left. */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * One reference.
 *
 * Every element is omitted when the note does not carry it, so a manuscript
 * written to §5.4 exactly — no volume, no pages — still produces a usable line
 * rather than "2026;undefined(undefined):undefined".
 */
export function formatCitation(
  publication: PublicationNote,
  format: CitationFormat = "vancouver",
): Citation {
  const names = publication.authors.map(authorName);
  const year = yearOf(publication);
  const venue = publication.abbreviation || publication.journal;
  const title = publication.title;
  const authors = authorList(names, format);

  let text: string;
  if (format === "apa") {
    const yearPart = year.year === null ? "(in progress)" : `(${year.year})`;
    const issue = publication.issue === "" ? "" : `(${publication.issue})`;
    const locator = joinParts([
      publication.volume === "" ? "" : `${publication.volume}${issue}`,
      publication.pages === "" ? "" : publication.pages,
    ]).replace(/\s+/, ", ");
    text = [
      authors === "" ? "" : sentence(authors),
      `${yearPart}.`,
      title === "" ? "" : sentence(title),
      venue === "" ? "" : `${venue}${locator === "" ? "" : `, ${locator}`}.`,
      publication.doi === "" ? "" : `https://doi.org/${publication.doi}`,
    ]
      .filter((part) => part !== "")
      .join(" ");
  } else {
    // Vancouver: Authors. Title. Journal. Year;Vol(Issue):Pages. doi:…
    const issue = publication.issue === "" ? "" : `(${publication.issue})`;
    const pages = publication.pages === "" ? "" : `:${publication.pages}`;
    const locator =
      publication.volume === "" && pages === ""
        ? ""
        : `;${publication.volume}${issue}${pages}`;
    const stamp = year.year === null ? "" : `${year.year}${locator}.`;
    text = [
      authors === "" ? "" : sentence(authors),
      title === "" ? "" : sentence(title),
      venue === "" ? "" : sentence(venue),
      stamp,
      publication.doi === "" ? "" : `doi:${publication.doi}`,
      publication.pmid === "" ? "" : `PMID: ${publication.pmid}`,
    ]
      .filter((part) => part !== "")
      .join(" ");
  }

  return {
    publication,
    text: text.trim(),
    year,
    uncertain: names.filter((name) => !name.confident),
  };
}

export interface YearGroup {
  /** Null groups the ones with no date at all, and sorts last. */
  year: number | null;
  citations: Citation[];
}

export interface ListOptions {
  format?: CitationFormat;
  /** "Papers this facility made possible" (§5.4) — the funding-committee cut. */
  scdbOnly?: boolean;
  /**
   * Stages to include. Defaults to everything that exists in the world:
   * a manuscript still in drafting is not a publication and listing it on a CV
   * would be a misrepresentation, so it is left out unless asked for.
   */
  stages?: readonly string[];
}

const LISTABLE: readonly string[] = ["published", "in-press", "accepted"];

/**
 * The publication list, newest year first.
 *
 * Within a year, ordered by the formatted text so the list is stable — two
 * papers with only a year between them have no other ordering the data
 * supports, and a list that reshuffles between runs is not one you can diff.
 */
export function formatList(
  publications: readonly PublicationNote[],
  options: ListOptions = {},
): YearGroup[] {
  const format = options.format ?? "vancouver";
  const stages = options.stages ?? LISTABLE;

  const citations = publications
    .filter((publication) => stages.includes(publication.stage))
    .filter((publication) => !options.scdbOnly || publication.scdbSupported)
    .map((publication) => formatCitation(publication, format));

  const groups = new Map<number | null, Citation[]>();
  for (const citation of citations) {
    const key = citation.year.year;
    const bucket = groups.get(key);
    if (bucket) bucket.push(citation);
    else groups.set(key, [citation]);
  }

  return [...groups.entries()]
    .map(([year, list]) => ({
      year,
      citations: list.sort((a, b) => a.text.localeCompare(b.text)),
    }))
    .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
}
