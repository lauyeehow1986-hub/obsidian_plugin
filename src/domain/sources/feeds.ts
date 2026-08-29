/**
 * The two syndication formats the guideline sources publish. Pure.
 *
 * RSS 2.0 for EACTS, a sitemap `urlset` for ESC. Both are read for the same
 * four facts — what it is, where it lives, when it changed — so they normalise
 * onto one record and the rest of the plugin never learns which was which.
 *
 * Dates are extracted textually rather than through `Date`. `new Date(…)` then
 * `toISOString()` silently converts to UTC, so a document published at 23:00 in
 * one time zone lands on the previous day in the note — the class of bug the
 * dwell-time tests exist to catch. What a feed states is what gets recorded.
 */

import { attrOf, decodeEntities, elements, looksLikeXml, stripCdata, stripTags, textOf } from "./xml";

/** One entry, from either format. */
export interface FeedEntry {
  /** Decoded, plain text. Empty when the source gave none. */
  title: string;
  /** Absolute URL, or `""` if the entry carried nothing usable. */
  link: string;
  /** `YYYY-MM-DD`, or `""` when the source gave no parsable date. */
  date: string;
  /** The date exactly as published, kept so the note can be checked. */
  rawDate: string;
}

export type Parsed = { entries: FeedEntry[] } | { why: string };

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * `Thu, 09 Oct 2025 15:04:00 +0000` → `2025-10-09`.
 *
 * Returns `""` rather than a guess. A wrong date on a guideline is worse than
 * no date: one is a gap, the other is a claim.
 */
export function rfc822Date(raw: string): string {
  const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(raw.trim());
  if (match === null) return "";
  const [, day, month, year] = match;
  const mm = MONTHS[(month ?? "").toLowerCase()];
  if (mm === undefined || day === undefined || year === undefined) return "";
  return `${year}-${mm}-${day.padStart(2, "0")}`;
}

/** `2026-08-13T14:34:16+00:00` → `2026-08-13`. Also accepts a bare date. */
export function isoDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  return match === null ? "" : `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Read an RSS 2.0 feed.
 *
 * `description` is deliberately not read. It carries the publisher's prose as
 * HTML, and the same argument applies as to PubMed abstracts (§7 E1): a title,
 * a link and a date are enough to decide whether to open something, and a
 * paragraph of someone else's text does not need to live in a vault holding
 * institutional data. Not reading it also means no HTML sanitiser to get wrong.
 */
export function parseFeed(xml: string): Parsed {
  if (!looksLikeXml(xml)) {
    return { why: "That reply was not XML — the feed address may have moved." };
  }
  const items = elements(xml, "item");
  if (items.length === 0) {
    // Atom rather than RSS, or an error document that happens to be XML.
    const atom = elements(xml, "entry");
    if (atom.length === 0) return { why: "That XML held no feed items." };
    return { entries: atom.map(atomEntry) };
  }
  return { entries: items.map(rssItem) };
}

function rssItem(item: string): FeedEntry {
  const rawDate = textOf(item, "pubDate");
  return {
    title: textOf(item, "title"),
    link: safeLink(textOf(item, "link")),
    date: rfc822Date(rawDate),
    rawDate,
  };
}

function atomEntry(entry: string): FeedEntry {
  const rawDate = textOf(entry, "updated") || textOf(entry, "published");
  return {
    title: textOf(entry, "title"),
    // Atom puts the target in an attribute, not in the element's text.
    link: safeLink(attrOf(entry, "link", "href")),
    date: isoDate(rawDate),
    rawDate,
  };
}

/**
 * Read a `sitemaps.org` urlset.
 *
 * `<loc>` is the title as well as the link: a sitemap carries no titles, and
 * the last path segment is what there is. `titleFromSlug` turns it into
 * something readable, and the note says plainly where it came from.
 */
export function parseSitemap(xml: string): Parsed {
  if (!looksLikeXml(xml)) {
    return { why: "That reply was not XML — the sitemap address may have moved." };
  }
  const urls = elements(xml, "url");
  if (urls.length === 0) return { why: "That XML held no sitemap entries." };

  return {
    entries: urls.map((url) => {
      const loc = safeLink(textOf(url, "loc"));
      const rawDate = textOf(url, "lastmod");
      return { title: titleFromSlug(loc), link: loc, date: isoDate(rawDate), rawDate };
    }),
  };
}

/**
 * A readable title from the last meaningful path segment.
 *
 * `…/all-esc-practice-guidelines/acute-coronary-syndromes/` becomes
 * "Acute coronary syndromes". Only the first letter is capitalised: title-casing
 * would produce "Cvd And Diabetes", and a wrong-looking title reads as a bug.
 */
export function titleFromSlug(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const segments = withoutQuery.split("/").filter((part) => part !== "");
  const last = segments[segments.length - 1] ?? "";
  const words = last.replace(/[-_]+/g, " ").trim();
  if (words === "") return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Only http(s) links survive, and only as text we control the shape of.
 *
 * A link out of a feed ends up in a markdown note. `javascript:` in a `<link>`
 * would become a clickable link in Obsidian, and rule 12 says a note must not
 * be able to run code. Anything else is dropped, and the entry is kept without
 * one — the title and date are still worth showing.
 */
function safeLink(raw: string): string {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) return "";
  // A link containing whitespace, a bracket or a backtick cannot be rendered
  // as a markdown target without escaping; dropping it is simpler and safer
  // than reasoning about how Obsidian will parse it.
  if (/[\s<>[\]()`"']/.test(text)) return "";
  return text;
}

/**
 * Exported for the tests that prove markup never reaches a note body. Same
 * order as `textOf`, and for the same reason.
 */
export const readable = (raw: string): string => decodeEntities(stripTags(stripCdata(raw))).trim();
