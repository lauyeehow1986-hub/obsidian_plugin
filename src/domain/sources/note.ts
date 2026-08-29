/**
 * Turning fetched records into a briefing note (§7 E1, "summarised into a
 * briefing note"). Pure.
 *
 * Every value that came from outside the vault goes through `foreignText`
 * before it reaches the body, and through `collapse` before it reaches
 * frontmatter. A fetched title is not allowed to become a wikilink, an embed,
 * or an early end to a table cell — see `domain/markdown/foreign`.
 */

import { collapse, foreignLine, foreignText, startOfLine } from "../markdown/foreign";
import { humanPhase, humanStatus, type TrialRecord } from "./ctgov";
import type { FeedEntry } from "./feeds";
import { SOURCES, type SourceId } from "./gateway";
import { isPmid, type PubmedRecord } from "./pubmed";

/** §5.14 lists the note types; this one is added by E1 and documented there. */
export const SOURCE_BRIEFING_TYPE = "source-briefing";

export interface SourceBriefing {
  /** Filename stem, without a folder or extension. */
  stem: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface BriefingInput {
  source: SourceId;
  /** Exactly what was searched for, as the user typed it. */
  query: string;
  /** The URL that was actually fetched, so the note is reproducible. */
  url: string;
  /** ISO 8601 local minute, e.g. `2026-08-29T14:03`. */
  fetchedAt: string;
  /** `YYYY-MM-DD`, for the filename. */
  date: string;
  /** Total matches the service reported, usually far more than were kept. */
  total: number;
  papers?: readonly PubmedRecord[];
  trials?: readonly TrialRecord[];
  guidelines?: readonly FeedEntry[];
  /**
   * What this source's results do and do not mean.
   *
   * Rendered above the entries rather than as a footnote. An ESC date is when
   * a page changed, not when a guideline was revised, and the note outlives
   * the conversation in which somebody explained that.
   */
  caveat?: string;
}

export function buildSourceBriefing(input: BriefingInput): SourceBriefing {
  const spec = SOURCES[input.source];
  const papers = input.papers ?? [];
  const trials = input.trials ?? [];
  const guidelines = input.guidelines ?? [];
  const kept = papers.length + trials.length + guidelines.length;

  const items =
    guidelines.length > 0
      ? guidelines.map(guidelineLines)
      : input.source === "pubmed"
        ? papers.map(paperLines)
        : trials.map(trialLines);

  // A guideline source has no query — the address is fixed — so the caller
  // passes the source's own name. Without this, both the heading and the
  // filename read "EACTS guidelines — EACTS guidelines".
  const query = collapse(input.query);
  const named = query !== "" && query !== spec.label;

  const body = [
    named ? `# ${spec.label} — ${foreignLine(input.query)}` : `# ${spec.label}`,
    "",
    // The provenance paragraph is the point of the note as much as the results
    // are. §5.1's argument about the eData system applies here too: this vault
    // is not the system of record, and a list of papers with no date and no
    // query on it is a claim about the literature that cannot be checked.
    `Fetched ${input.fetchedAt} from ${spec.host} (${spec.operator}).`,
    `${spec.label} reported **${input.total.toLocaleString("en-GB")}** matches; ` +
      `the **${kept}** below are the ones that were kept.`,
    "",
    // Written by us, so not escaped — and deliberately before the results.
    ...(input.caveat === undefined || input.caveat === "" ? [] : [input.caveat, ""]),
    `This is a snapshot of one search on one day, not a systematic review, and ` +
      `nothing in it has been checked against anything. Re-running the same ` +
      `search tomorrow will give a different answer.`,
    "",
    "---",
    "",
    ...(kept === 0 ? ["Nothing was kept from this search."] : items.flat()),
  ].join("\n");

  return {
    stem: named
      ? `${input.date} ${spec.label} — ${fileSafe(input.query)}`
      : `${input.date} ${spec.label}`,
    frontmatter: {
      type: SOURCE_BRIEFING_TYPE,
      source: input.source,
      // Collapsed, not escaped: frontmatter is YAML and a backslash written
      // here is a backslash you read back out of the note forever.
      query,
      host: spec.host,
      url: input.url,
      fetched: input.fetchedAt,
      total: input.total,
      kept,
    },
    body,
  };
}

function paperLines(record: PubmedRecord): string[] {
  const meta: string[] = [];
  const journal = record.fullJournal === "" ? record.journal : record.fullJournal;
  if (journal !== "") meta.push(`*${foreignText(journal)}*`);
  if (record.pubdate !== "") meta.push(foreignText(record.pubdate));
  // `58(1):2651008`, not `58(1)2651008`. Joined with nothing between them,
  // three separate values read as one number.
  const volume = `${record.volume}${record.issue === "" ? "" : `(${record.issue})`}`;
  const cite = [volume, record.pages].filter((part) => part !== "").join(":");
  if (cite !== "") meta.push(foreignText(cite));

  const ids: string[] = [];
  // Built from a value already proved to be digits, so the link cannot be
  // steered by whatever the service returned in that field.
  if (isPmid(record.pmid)) {
    ids.push(`[PMID ${record.pmid}](https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/)`);
  }
  if (record.doi !== "") ids.push(`doi ${foreignText(record.doi)}`);

  return [
    `### ${foreignText(record.title === "" ? "(untitled)" : record.title)}`,
    "",
    meta.length === 0 ? "" : startOfLine(meta.join(" · ")),
    authorLine(record.authors),
    ids.length === 0 ? "" : ids.join(" · "),
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === ""));
}

/**
 * Author lists are truncated at six, which is the Vancouver convention the
 * publication list already follows (§5.4) and the point past which a briefing
 * line stops being scannable.
 */
function authorLine(authors: readonly string[]): string {
  if (authors.length === 0) return "";
  const shown = authors.slice(0, 6).map(foreignText);
  return startOfLine(authors.length > 6 ? `${shown.join(", ")}, et al.` : shown.join(", "));
}

function trialLines(record: TrialRecord): string[] {
  const meta: string[] = [foreignText(humanStatus(record.status))];
  const phase = humanPhase(record.phases);
  if (phase !== "") meta.push(foreignText(phase));
  if (record.studyType !== "") meta.push(foreignText(humanStatus(record.studyType)));
  if (record.enrolment !== "") meta.push(`n = ${foreignText(record.enrolment)}`);

  const dates: string[] = [];
  if (record.start !== "") dates.push(`started ${foreignText(record.start)}`);
  if (record.primaryCompletion !== "") {
    dates.push(`primary completion ${foreignText(record.primaryCompletion)}`);
  }

  return [
    `### ${foreignText(record.title === "" ? "(untitled)" : record.title)}`,
    "",
    startOfLine(meta.join(" · ")),
    record.sponsor === "" ? "" : `Sponsor: ${foreignText(record.sponsor)}`,
    record.conditions.length === 0 ? "" : startOfLine(record.conditions.map(foreignText).join(", ")),
    record.countries.length === 0 ? "" : startOfLine(record.countries.map(foreignText).join(", ")),
    dates.join(" · "),
    `[${record.nctId}](https://clinicaltrials.gov/study/${record.nctId})`,
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === ""));
}

/**
 * One guideline, from a feed or a sitemap.
 *
 * Sparser than a paper on purpose: a title, a date and a link is everything
 * either source gives, and inventing a richer-looking record would misrepresent
 * how much is actually known about it.
 */
function guidelineLines(entry: FeedEntry): string[] {
  const meta: string[] = [];
  if (entry.date !== "") meta.push(foreignText(entry.date));

  // The link is already proved to be an unadorned http(s) URL by `safeLink`,
  // so it cannot carry a bracket that would break out of the markdown target.
  const link = entry.link === "" ? "" : `[Open](${entry.link})`;

  return [
    `### ${foreignText(entry.title === "" ? "(untitled)" : entry.title)}`,
    "",
    meta.length === 0 ? "" : startOfLine(meta.join(" · ")),
    link,
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === ""));
}

/**
 * A filename stem from a query the user typed.
 *
 * The characters removed are the ones Windows and Obsidian refuse in a name,
 * plus the ones that would make the note's own link ambiguous. Length is
 * capped because a pasted PubMed query can run to hundreds of characters and
 * Windows still has a path limit.
 */
export function fileSafe(query: string): string {
  const cleaned = collapse(query)
    .replace(/[\\/:*?"<>|[\]#^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
  return capped === "" ? "search" : capped;
}
