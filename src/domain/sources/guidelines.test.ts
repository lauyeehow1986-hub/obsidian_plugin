import { describe, expect, it } from "vitest";

import { EACTS_FEED, ESC_SITEMAP, NOT_XML } from "./guidelines.fixture";
import { isoDate, parseFeed, parseSitemap, rfc822Date, titleFromSlug } from "./feeds";
import {
  ESC_GUIDELINE_PREFIX,
  GUIDELINE_SOURCES,
  newestFirst,
  onlyEscGuidelines,
  parseGuidelines,
  PUBMED_GUIDELINES,
} from "./guidelines";
import { attrOf, decodeEntities, elements, stripCdata, stripTags, textOf } from "./xml";

describe("xml, the small part of it we read", () => {
  it("decodes the entities a CMS actually emits", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("EACTS &#8211; news")).toBe("EACTS – news");
    expect(decodeEntities("&#x2014;")).toBe("—");
    expect(decodeEntities("EACTS &raquo; Feed")).toBe("EACTS » Feed");
  });

  it("leaves an entity it does not know rather than eating it", () => {
    // Deleting text because we did not recognise a name would silently corrupt
    // a title. Leaving it visible is the honest failure.
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
    expect(decodeEntities("&#999999999;")).toBe("&#999999999;");
  });

  it("unwraps CDATA, including an unterminated section", () => {
    expect(stripCdata("<![CDATA[hello]]>")).toBe("hello");
    expect(stripCdata("a<![CDATA[b]]>c<![CDATA[d]]>")).toBe("abcd");
    expect(stripCdata("<![CDATA[cut off")).toBe("cut off");
  });

  it("does not match an element whose name merely starts the same", () => {
    // `<items>` is not `<item>`; a scan that missed this would read a feed's
    // wrapper as its first entry.
    expect(elements("<items><item>a</item></items>", "item")).toEqual(["a"]);
  });

  it("treats a self-closing element as present and empty", () => {
    expect(elements("<link/>", "link")).toEqual([""]);
  });

  it("reads a namespaced element by its literal name", () => {
    expect(textOf("<dc:creator><![CDATA[A Name]]></dc:creator>", "dc:creator")).toBe("A Name");
  });

  it("strips tags before decoding, so escaped markup survives as text", () => {
    // The ordering that matters. `&lt;p&gt;` is text the feed deliberately
    // escaped in order to show it; decoding first makes it a tag, which the
    // strip then deletes — losing content and looking like nothing happened.
    expect(stripTags(decodeEntities("&lt;p&gt;kept"))).toBe("kept"); // the wrong order
    expect(textOf("<title>&lt;p&gt;kept</title>", "title")).toBe("<p>kept"); // the right one
    expect(textOf("<title><p>real markup</p>gone</title>", "title")).toBe("real markupgone");
  });

  it("reads an attribute off the first matching tag", () => {
    expect(attrOf('<link href="https://x.example/a" rel="alternate" />', "link", "href")).toBe(
      "https://x.example/a",
    );
    expect(attrOf("<link>text</link>", "link", "href")).toBe("");
  });
});

describe("dates, extracted textually and never through Date", () => {
  it("reads an RFC 822 pubDate", () => {
    expect(rfc822Date("Thu, 09 Oct 2025 15:04:00 +0000")).toBe("2025-10-09");
    expect(rfc822Date("1 Feb 2026 00:00:00 GMT")).toBe("2026-02-01");
  });

  it("does not shift a date across a time zone", () => {
    // The bug this avoids: `new Date(…).toISOString()` on a late-evening
    // timestamp in a positive offset lands on the previous day.
    expect(rfc822Date("Wed, 31 Dec 2025 23:30:00 +0800")).toBe("2025-12-31");
    expect(isoDate("2025-12-31T23:30:00+08:00")).toBe("2025-12-31");
  });

  it("returns nothing rather than guessing", () => {
    expect(rfc822Date("sometime last year")).toBe("");
    expect(rfc822Date("")).toBe("");
    expect(isoDate("not a date")).toBe("");
  });
});

describe("the EACTS feed, as it actually arrives", () => {
  const parsed = parseFeed(EACTS_FEED);

  it("parses", () => {
    expect("why" in parsed).toBe(false);
  });

  it("reads every item, and only the items", () => {
    if ("why" in parsed) throw new Error(parsed.why);
    // Four in the fixture. The channel's own <title> is not one of them.
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries.map((e) => e.title)).not.toContain("Clinical Practice Guidelines - EACTS");
  });

  it("carries real guideline titles, links and dates", () => {
    if ("why" in parsed) throw new Error(parsed.why);
    const first = parsed.entries[0];
    expect(first?.title).toContain("EACTS Expert Consensus Document");
    expect(first?.link).toMatch(/^https:\/\/www\.eacts\.org\/clinical-practice-guideline\//);
    expect(first?.date).toBe("2025-10-09");
    expect(first?.rawDate).toContain("Oct 2025");
  });

  it("keeps no HTML and no publisher prose", () => {
    if ("why" in parsed) throw new Error(parsed.why);
    for (const entry of parsed.entries) {
      expect(entry.title).not.toMatch(/[<>]/);
      // `description` carries "The post <a href=…> appeared first on …". None
      // of that is read, so none of it can reach a note.
      expect(entry.title).not.toContain("appeared first on");
    }
  });
});

describe("the ESC sitemap, as it actually arrives", () => {
  const parsed = parseSitemap(ESC_SITEMAP);

  it("parses every url element", () => {
    if ("why" in parsed) throw new Error(parsed.why);
    expect(parsed.entries).toHaveLength(10);
    expect(parsed.entries.every((e) => e.date !== "")).toBe(true);
  });

  it("keeps only the guideline prefix, and not the prefix itself", () => {
    if ("why" in parsed) throw new Error(parsed.why);
    const kept = onlyEscGuidelines(parsed.entries);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(parsed.entries.length);
    for (const entry of kept) {
      expect(entry.link.startsWith(ESC_GUIDELINE_PREFIX)).toBe(true);
      expect(entry.link).not.toBe(ESC_GUIDELINE_PREFIX);
    }
  });

  it("builds a readable title from the slug without title-casing it", () => {
    // "Cvd And Diabetes" reads as a bug; "Cvd and diabetes" reads as a slug
    // turned into a sentence, which is what it is.
    expect(titleFromSlug(`${ESC_GUIDELINE_PREFIX}cvd-and-diabetes/`)).toBe("Cvd and diabetes");
    expect(titleFromSlug(`${ESC_GUIDELINE_PREFIX}heart-failure/`)).toBe("Heart failure");
    expect(titleFromSlug("https://example.org/")).toBe("Example.org");
  });
});

describe("what a non-XML reply does", () => {
  it("is refused with a sentence, not a parse error", () => {
    const feed = parseFeed(NOT_XML);
    const map = parseSitemap(NOT_XML);
    // An HTML 404 page is XML-shaped enough to reach the element scan, so the
    // useful refusal is "no items", not "not XML".
    expect("why" in feed && feed.why.length > 0).toBe(true);
    expect("why" in map && map.why.length > 0).toBe(true);
  });

  it("refuses an empty body", () => {
    expect("why" in parseFeed("")).toBe(true);
    expect("why" in parseSitemap("")).toBe(true);
  });
});

describe("link safety, because a feed entry becomes a markdown link", () => {
  it("drops anything that is not http(s)", () => {
    const parsed = parseFeed(
      "<rss><channel><item><title>x</title>" +
        "<link>javascript:alert(1)</link></item></channel></rss>",
    );
    if ("why" in parsed) throw new Error(parsed.why);
    // Rule 12: a note must not be able to run code. The entry survives without
    // its link; the link does not survive at all.
    expect(parsed.entries[0]?.link).toBe("");
    expect(parsed.entries[0]?.title).toBe("x");
  });

  it("drops a link carrying brackets that would break the markdown target", () => {
    const parsed = parseFeed(
      "<rss><channel><item><title>x</title>" +
        "<link>https://a.example/a)b[c]</link></item></channel></rss>",
    );
    if ("why" in parsed) throw new Error(parsed.why);
    expect(parsed.entries[0]?.link).toBe("");
  });
});

describe("ordering and limits", () => {
  it("puts the newest first and undated last", () => {
    const ordered = newestFirst([
      { title: "old", link: "", date: "2024-01-01", rawDate: "" },
      { title: "none", link: "", date: "", rawDate: "" },
      { title: "new", link: "", date: "2026-05-05", rawDate: "" },
    ]);
    expect(ordered.map((e) => e.title)).toEqual(["new", "old", "none"]);
  });

  it("applies the cap through parseGuidelines", () => {
    const two = parseGuidelines("eacts", EACTS_FEED, 2);
    if ("why" in two) throw new Error(two.why);
    expect(two.entries).toHaveLength(2);
  });

  it("never returns zero because the caller asked for zero", () => {
    const none = parseGuidelines("eacts", EACTS_FEED, 0);
    if ("why" in none) throw new Error(none.why);
    expect(none.entries.length).toBeGreaterThan(0);
  });

  it("uses the parser the source declares, not the shape of the reply", () => {
    // A sitemap fed to the feed source must fail rather than be sniffed.
    const wrong = parseGuidelines("eacts", ESC_SITEMAP, 5);
    expect("why" in wrong).toBe(true);
  });
});

describe("the sources, and what is deliberately not one", () => {
  it("names a URL and a caveat for each", () => {
    for (const spec of Object.values(GUIDELINE_SOURCES)) {
      expect(spec.url()).toMatch(/^https:\/\//);
      expect(spec.caveat.length).toBeGreaterThan(40);
    }
  });

  it("does not repeat a hostname outside the allowlist module", () => {
    // Two copies of a hostname is how an allowlist stops describing what is
    // actually fetched. The URLs here are checked by the gateway at send time.
    const source = GUIDELINE_SOURCES;
    expect(Object.values(source).every((s) => !("host" in s))).toBe(true);
  });

  it("keeps the PubMed guideline query to publication types and journals", () => {
    expect(PUBMED_GUIDELINES).toContain("guideline[pt]");
    expect(PUBMED_GUIDELINES).toContain("Circulation");
    expect(PUBMED_GUIDELINES).toContain("Ann Thorac Surg");
  });

  it("does not quote a publication type", () => {
    // PubMed drops a quoted phrase it cannot find and runs the search anyway.
    // `"practice guideline"[pt]` did exactly that, so the query silently became
    // a narrower one. Unquoted it matches, and the live count is unchanged.
    expect(PUBMED_GUIDELINES).not.toMatch(/"[^"]*"\[pt\]/);
  });

  it("reaches the two societies that publish no feed", () => {
    // The whole justification for this constant: ACC/AHA land in Circulation
    // and JACC, STS in the Annals. If a journal is dropped from here, the
    // society it stands for silently stops being covered at all.
    expect(PUBMED_GUIDELINES).toContain("J Am Coll Cardiol"); // ACC
    expect(PUBMED_GUIDELINES).toContain("Circulation"); // AHA/ACC
    expect(PUBMED_GUIDELINES).toContain("Ann Thorac Surg"); // STS
  });
});
