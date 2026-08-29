/**
 * PubMed via NCBI E-utilities (§7 E1). Pure: builds URLs, parses responses.
 *
 * Read-only, and only ever on an explicit action. Nothing here is called on
 * load, on note open, or on a timer.
 *
 * **Abstracts are deliberately not fetched.** ESummary is JSON and carries
 * everything a triage decision needs — title, journal, date, authors, DOI. The
 * abstract lives behind EFetch, which is XML only, and it is a paragraph of
 * someone else's prose that would then sit inside a vault §5.10 describes as a
 * regulated data store. Metadata plus a link keeps the reading at the source,
 * where it belongs, and keeps an XML parser out of the bundle.
 */

import { DEFAULT_RESULTS, MAX_RESULTS } from "./gateway";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/**
 * NCBI asks callers to identify themselves so they can contact whoever is
 * hammering the service. `tool` is fixed; `email` comes from settings and is
 * **empty unless the user types one in**. It is never taken from the account,
 * the git config or anywhere else the plugin happens to know an address from.
 */
export interface PubmedIdentity {
  email: string;
}

function identityParams(identity: PubmedIdentity): string {
  const email = identity.email.trim();
  // A malformed address would be sent verbatim to NCBI and help nobody, so an
  // address that is not obviously one is simply left off.
  const usable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  return `&tool=scdb-cockpit${usable === "" ? "" : `&email=${encodeURIComponent(usable)}`}`;
}

export type PubmedSort = "relevance" | "pub_date";

export interface PubmedSearchOptions {
  query: string;
  retmax?: number;
  sort?: PubmedSort;
  /** `YYYY/MM/DD`, or empty. Both bounds or neither — NCBI ignores a lone one. */
  from?: string;
  to?: string;
}

export function pubmedSearchUrl(options: PubmedSearchOptions, identity: PubmedIdentity): string {
  const retmax = clampResults(options.retmax);
  const sort = options.sort === "pub_date" ? "&sort=pub_date" : "";
  const from = (options.from ?? "").trim();
  const to = (options.to ?? "").trim();
  const dates =
    from !== "" && to !== ""
      ? `&datetype=pdat&mindate=${encodeURIComponent(from)}&maxdate=${encodeURIComponent(to)}`
      : "";
  return (
    `${BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}` +
    `&term=${encodeURIComponent(options.query)}${sort}${dates}${identityParams(identity)}`
  );
}

/** A DOI is looked up through PubMed's own index rather than a third host. */
export function pubmedDoiUrl(doi: string, identity: PubmedIdentity): string {
  return (
    `${BASE}/esearch.fcgi?db=pubmed&retmode=json&retmax=2` +
    `&term=${encodeURIComponent(`${normaliseDoi(doi)}[doi]`)}${identityParams(identity)}`
  );
}

export function pubmedSummaryUrl(ids: readonly string[], identity: PubmedIdentity): string {
  const clean = ids.filter(isPmid).slice(0, MAX_RESULTS);
  return `${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${clean.join(",")}${identityParams(identity)}`;
}

/** PubMed identifiers are digits. Anything else never reaches a URL. */
export function isPmid(value: string): boolean {
  return /^\d{1,9}$/.test(value.trim());
}

/**
 * Strip the prefixes people paste along with a DOI.
 *
 * A DOI copied from a browser arrives as `https://doi.org/10.1038/…`, and one
 * copied from a citation as `doi:10.1038/…`. Sending either verbatim finds
 * nothing, which reads as "the lookup is broken" rather than "you pasted a URL".
 */
export function normaliseDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

export function looksLikeDoi(raw: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(normaliseDoi(raw));
}

function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.floor(value)));
}

// ---------------------------------------------------------------- parsing ---

/**
 * Everything below treats the response as untrusted input.
 *
 * It is JSON from a service we do not control, arriving over a network. Each
 * field is narrowed rather than cast, a missing one yields an empty string
 * rather than `undefined` leaking into a note, and nothing fetched is ever
 * executed, rendered as HTML, or used to build another URL.
 */

export interface PubmedSearchResult {
  ids: string[];
  /** Total matches, which is usually far more than were returned. */
  total: number;
  /** How PubMed understood the query. Worth showing: it is often not obvious. */
  translation: string;
  /** NCBI's own complaints about the query, e.g. a phrase it could not find. */
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parsePubmedSearch(body: string): PubmedSearchResult | { why: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { why: "PubMed replied with something that is not JSON." };
  }
  const root = asRecord(json);
  const result = asRecord(root?.["esearchresult"]);
  if (result === null) {
    const error = asString(root?.["error"] ?? root?.["ERROR"]);
    return { why: error === "" ? "PubMed replied without a result." : `PubMed said: ${error}` };
  }
  const warnings = asRecord(result["warninglist"]);
  const total = Number.parseInt(asString(result["count"]), 10);
  return {
    ids: asStringArray(result["idlist"]).filter(isPmid),
    total: Number.isFinite(total) ? total : 0,
    translation: asString(result["querytranslation"]),
    warnings: [
      ...asStringArray(warnings?.["outputmessages"]),
      ...asStringArray(warnings?.["quotedphrasesnotfound"]).map(
        (phrase) => `PubMed found no match for the phrase ${phrase}`,
      ),
    ],
  };
}

export interface PubmedRecord {
  pmid: string;
  title: string;
  /** Journal abbreviation, as PubMed gives it. */
  journal: string;
  fullJournal: string;
  /** As printed, e.g. "2018 Mar 29". Not parsed into a date: it is often partial. */
  pubdate: string;
  year: string;
  authors: string[];
  volume: string;
  issue: string;
  pages: string;
  doi: string;
  pubtypes: string[];
}

export function parsePubmedSummaries(body: string): PubmedRecord[] | { why: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { why: "PubMed replied with something that is not JSON." };
  }
  const result = asRecord(asRecord(json)?.["result"]);
  if (result === null) return { why: "PubMed replied without any records." };

  const order = asStringArray(result["uids"]);
  const records: PubmedRecord[] = [];
  for (const uid of order) {
    const raw = asRecord(result[uid]);
    // A record can come back as `{ uid, error }` for an id PubMed will not
    // serve. Skipping it silently would be wrong in a list the user chose from,
    // so the caller compares what it asked for against what it got.
    if (raw === null || asString(raw["error"]) !== "") continue;
    records.push(toRecord(uid, raw));
  }
  return records;
}

function toRecord(uid: string, raw: Record<string, unknown>): PubmedRecord {
  const pubdate = asString(raw["pubdate"]);
  return {
    pmid: uid,
    // PubMed ends most titles with a full stop; a title used as a heading or a
    // frontmatter value should not carry one.
    title: asString(raw["title"]).replace(/\.$/, "").trim(),
    journal: asString(raw["source"]),
    fullJournal: asString(raw["fulljournalname"]),
    pubdate,
    year: /^(\d{4})/.exec(pubdate)?.[1] ?? "",
    authors: Array.isArray(raw["authors"])
      ? raw["authors"]
          .map((entry) => asString(asRecord(entry)?.["name"]))
          .filter((name) => name !== "")
      : [],
    volume: asString(raw["volume"]),
    issue: asString(raw["issue"]),
    pages: asString(raw["pages"]),
    doi: articleId(raw["articleids"], "doi"),
    pubtypes: asStringArray(raw["pubtype"]),
  };
}

function articleId(list: unknown, want: string): string {
  if (!Array.isArray(list)) return "";
  for (const entry of list) {
    const record = asRecord(entry);
    if (record !== null && asString(record["idtype"]) === want) return asString(record["value"]);
  }
  return "";
}

// ------------------------------------------------------------- enrichment ---

/**
 * What a fetched record may propose into a `type: publication` note (§5.4).
 *
 * **Authors are not on this list, and that is a decision rather than an
 * omission.** §5.4 stores authors as wikilinks into `30 People/`; a fetch
 * returns eighteen surname-initial strings. Writing those in would either
 * break the link convention or create eighteen people notes for co-authors
 * nobody in the department has met. The same goes for `position` and
 * `corresponding`, which are facts about you that no external record holds.
 *
 * Nothing here is applied automatically. The caller shows each field, its
 * current value and the proposed one, and the user picks (rule 5's spirit:
 * fetched text populates a form, it does not change a note).
 */
export const ENRICHABLE_FIELDS = ["title", "journal", "doi", "pmid", "year"] as const;
export type EnrichableField = (typeof ENRICHABLE_FIELDS)[number];

export interface FieldProposal {
  field: EnrichableField;
  current: string;
  proposed: string;
  /** True when the note already says something different — needs a human. */
  conflict: boolean;
}

export function proposeFields(
  record: PubmedRecord,
  current: Readonly<Record<string, unknown>>,
): FieldProposal[] {
  const wanted: Record<EnrichableField, string> = {
    title: record.title,
    // The full name, not the abbreviation: §5.4's example is "European Heart
    // Journal", and an abbreviation is a lossy form of the same fact.
    journal: record.fullJournal === "" ? record.journal : record.fullJournal,
    doi: record.doi,
    pmid: record.pmid,
    year: record.year,
  };

  const proposals: FieldProposal[] = [];
  for (const field of ENRICHABLE_FIELDS) {
    const proposed = wanted[field];
    if (proposed === "") continue;
    const raw = current[field];
    const now = raw === undefined || raw === null ? "" : String(raw).trim();
    if (now === proposed) continue;
    proposals.push({ field, current: now, proposed, conflict: now !== "" });
  }
  return proposals;
}
