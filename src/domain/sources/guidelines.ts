/**
 * Cardiac and cardiothoracic guideline sources (§7 E1, "guideline feeds").
 *
 * §7 named the category; the user named the societies — ESC, ACC/AHA, and
 * cardiothoracic surgery. Four were probed against the live sites before any of
 * this was written, and only two can be read the way a governance tool should
 * read anything. What follows records that, because the reasoning is the part
 * that stops somebody re-litigating it in a year.
 *
 * **EACTS — a dedicated feed, and the best source found.** The society
 * publishes `…/clinical-practice-guidelines/feed/` and declares it from the
 * guidelines page itself. It carries real document titles, links and dates, and
 * it includes the joint ESC/EACTS and EACTS/STS/AATS documents.
 *
 * **ESC — a sitemap, and a weaker signal.** No feed is published. The sitemap
 * named in `robots.txt` carries every guideline topic under one path prefix
 * with a `<lastmod>` each. That is a real change signal but **not** a
 * publication signal: `lastmod` moves when anything on the page changes, a
 * fixed link included. `ESC_CAVEAT` says so wherever the results are shown,
 * because a reader who assumes otherwise is being misled by our omission.
 *
 * **ACC — not built, and the site says not to.** `acc.org/robots.txt` carries
 * `Disallow: /guideline-recommendations`, which is the guidelines path itself.
 * The site's own statement about automated access is the end of the argument;
 * there is no version of this that is technically clever enough to be all
 * right. Its sitemap is also 5.7 MB, over `MAX_BYTES` in the gateway, and has
 * no path prefix that separates guidelines from press releases.
 *
 * **STS — not built, because the word is ambiguous there.** No feed, and in the
 * sitemap "guidelines" matches abstract-submission rules and media-relations
 * policy as often as clinical practice documents. A filter would return noise
 * and call it a guideline list.
 *
 * Both of those are covered instead by `PUBMED_GUIDELINES`, which finds the
 * published documents through a host already on the allowlist.
 *
 * Pure — no Obsidian, no network.
 */

import { parseFeed, parseSitemap, type FeedEntry } from "./feeds";

export const GUIDELINE_SOURCE_IDS = ["eacts", "esc"] as const;
export type GuidelineSourceId = (typeof GUIDELINE_SOURCE_IDS)[number];

export function isGuidelineSourceId(value: unknown): value is GuidelineSourceId {
  return typeof value === "string" && (GUIDELINE_SOURCE_IDS as readonly string[]).includes(value);
}

/** The EACTS clinical practice guidelines feed, as the site declares it. */
export function eactsFeedUrl(): string {
  return "https://www.eacts.org/clinical-practice-guidelines/feed/";
}

/** The ESC sitemap, as named in `escardio.org/robots.txt`. */
export function escSitemapUrl(): string {
  return "https://www.escardio.org/escardio4-sitemap.xml";
}

/**
 * The one path prefix under which ESC keeps its practice guidelines.
 *
 * Checked against the live sitemap: 32 topic pages sit under it, and nothing
 * else on the site does. Narrow on purpose — the commentary and congress
 * coverage that merely mention guidelines are not guidelines.
 */
export const ESC_GUIDELINE_PREFIX =
  "https://www.escardio.org/guidelines/clinical-practice-guidelines/all-esc-practice-guidelines/";

/**
 * Shown with every ESC result. Not a footnote — the first thing under the
 * heading, because the note outlives the moment somebody explained it.
 */
export const ESC_CAVEAT =
  "ESC publishes no guideline feed, so these come from its sitemap: the date is when the " +
  "page last changed, which is not the same as when the guideline was revised. Treat it as " +
  "'worth a look', never as evidence of a new version.";

/** Shown with every EACTS result, for the same reason: say what this is. */
export const EACTS_CAVEAT =
  "From the EACTS clinical practice guidelines feed. The feed carries the most recent " +
  "entries only, so this is the current window and not a complete list.";

/**
 * Why ACC and STS are absent, in the words the UI uses.
 *
 * Surfaced rather than buried: the user asked for four societies by name, and
 * silently delivering two would read as the feature working.
 */
export const DECLINED_SOURCES: readonly { society: string; why: string }[] = [
  {
    society: "American College of Cardiology",
    why:
      "acc.org publishes no feed, and its robots.txt asks automated clients to stay out of " +
      "/guideline-recommendations — the guidelines path itself. Its sitemap is also larger " +
      "than this plugin will download.",
  },
  {
    society: "Society of Thoracic Surgeons",
    why:
      "sts.org publishes no feed, and on that site 'guidelines' covers abstract submission " +
      "and media relations as often as clinical practice, with no path that separates them.",
  },
];

/**
 * A PubMed search that finds what ACC and STS will not hand over directly.
 *
 * Guidelines are published in journals, and PubMed indexes them with a
 * publication type. This reaches ACC/AHA through *Circulation* and *JACC* and
 * STS through the *Annals*, and it costs no new host — the same argument that
 * resolves a DOI through PubMed rather than adding Crossref.
 *
 * The trade is indexing lag of days to weeks, and that it finds the published
 * document rather than a society web announcement.
 *
 * **Publication types are not quoted, and that is not a style choice.** The
 * first version wrote `"practice guideline"[pt]`, and PubMed answered with
 * `quotedphrasesnotfound` — it dropped the term and ran the search without it,
 * which is the silent failure the warning line in the results view exists to
 * catch. Unquoted, the same search returns 1,248 records and no warning.
 * Verified against the live service rather than reasoned about.
 *
 * `consensus development conference[pt]` was dropped for a duller reason: with
 * it the count was also 1,248, so it earned nothing.
 */
export const PUBMED_GUIDELINES =
  "(guideline[pt] OR practice guideline[pt]) " +
  'AND ("Eur Heart J"[ta] OR "Circulation"[ta] OR "J Am Coll Cardiol"[ta] ' +
  'OR "JACC Cardiovasc Interv"[ta] OR "Eur J Cardiothorac Surg"[ta] ' +
  'OR "Ann Thorac Surg"[ta] OR "J Thorac Cardiovasc Surg"[ta])';

export const PUBMED_GUIDELINES_LABEL = "Cardiac guidelines in the major journals";

/**
 * The guideline-specific half of a source. Label, host and operator are **not**
 * repeated here — they live in `gateway`, which is the allowlist and therefore
 * the one place a host may be written down. Two copies of a hostname is how an
 * allowlist quietly stops describing what actually gets fetched.
 */
export interface GuidelineSourceSpec {
  id: GuidelineSourceId;
  url: () => string;
  caveat: string;
}

export const GUIDELINE_SOURCES: Record<GuidelineSourceId, GuidelineSourceSpec> = {
  eacts: { id: "eacts", url: eactsFeedUrl, caveat: EACTS_CAVEAT },
  esc: { id: "esc", url: escSitemapUrl, caveat: ESC_CAVEAT },
};

/**
 * What one fetched body held: the entries kept, and how many there were.
 *
 * `total` is the count **before** the cap, so a briefing can say "32 offered,
 * 20 kept" the way a PubMed search says "6,340 matched". A capped list that
 * cannot say it was capped is a list quietly claiming to be complete.
 */
export type ParsedGuidelines = { entries: FeedEntry[]; total: number } | { why: string };

/**
 * Turn one fetched body into guideline entries.
 *
 * Which parser to use is a property of the source, not of the reply, so a
 * sitemap arriving where a feed was expected fails rather than being sniffed
 * and half-understood.
 */
export function parseGuidelines(
  source: GuidelineSourceId,
  body: string,
  limit: number,
): ParsedGuidelines {
  const parsed = source === "eacts" ? parseFeed(body) : parseSitemap(body);
  if ("why" in parsed) return parsed;

  const kept = source === "esc" ? onlyEscGuidelines(parsed.entries) : parsed.entries;
  return {
    entries: newestFirst(kept).slice(0, Math.max(1, limit)),
    total: kept.length,
  };
}

/** The sitemap is the whole site; only one prefix of it is guidelines. */
export function onlyEscGuidelines(entries: readonly FeedEntry[]): FeedEntry[] {
  return entries.filter(
    (entry) => entry.link.startsWith(ESC_GUIDELINE_PREFIX) && entry.link !== ESC_GUIDELINE_PREFIX,
  );
}

/**
 * Newest first, with undated entries last rather than dropped.
 *
 * String comparison is correct here because every date is `YYYY-MM-DD` or the
 * empty string — and is stable, so a source that returns a deliberate order
 * keeps it within a date.
 */
export function newestFirst(entries: readonly FeedEntry[]): FeedEntry[] {
  return [...entries].sort((a, b) => {
    if (a.date === b.date) return 0;
    if (a.date === "") return 1;
    if (b.date === "") return -1;
    return a.date < b.date ? 1 : -1;
  });
}
