import { describe, expect, it } from "vitest";
import { checkUrl } from "./gateway";
import {
  isPmid,
  looksLikeDoi,
  normaliseDoi,
  parsePubmedSearch,
  parsePubmedSummaries,
  proposeFields,
  pubmedDoiUrl,
  pubmedSearchUrl,
  pubmedSummaryUrl,
  type PubmedRecord,
} from "./pubmed";
import {
  PUBMED_SEARCH,
  PUBMED_SEARCH_PHRASE_DROPPED,
  PUBMED_SUMMARY,
  PUBMED_SUMMARY_WITH_ERROR,
} from "./responses.fixture";

const NOBODY = { email: "" };

describe("building PubMed URLs", () => {
  it("always passes the gate it will be checked by", () => {
    expect(checkUrl(pubmedSearchUrl({ query: "heart failure" }, NOBODY)).ok).toBe(true);
    expect(checkUrl(pubmedSummaryUrl(["29562234"], NOBODY)).ok).toBe(true);
    expect(checkUrl(pubmedDoiUrl("10.1038/nature26140", NOBODY)).ok).toBe(true);
  });

  it("encodes the query rather than letting it add parameters", () => {
    const url = pubmedSearchUrl({ query: "a&retmax=999&db=nuccore b" }, NOBODY);
    expect(url).toContain("term=a%26retmax%3D999%26db%3Dnuccore%20b");
    expect(url.match(/retmax=/g)).toHaveLength(1);
    expect(url.match(/db=/g)).toHaveLength(1);
  });

  it("identifies the tool but sends no address unless one was typed", () => {
    expect(pubmedSearchUrl({ query: "x" }, NOBODY)).toContain("tool=scdb-cockpit");
    expect(pubmedSearchUrl({ query: "x" }, NOBODY)).not.toContain("email=");
    expect(pubmedSearchUrl({ query: "x" }, { email: "a@b.org" })).toContain("email=a%40b.org");
  });

  it("leaves off an address that is not one, rather than sending nonsense", () => {
    expect(pubmedSearchUrl({ query: "x" }, { email: "not an address" })).not.toContain("email=");
  });

  it("clamps the result count both ways", () => {
    expect(pubmedSearchUrl({ query: "x", retmax: 5000 }, NOBODY)).toContain("retmax=50");
    expect(pubmedSearchUrl({ query: "x", retmax: 0 }, NOBODY)).toContain("retmax=1");
    expect(pubmedSearchUrl({ query: "x", retmax: Number.NaN }, NOBODY)).toContain("retmax=20");
  });

  it("sends a date range only when both bounds are given", () => {
    // NCBI ignores a lone bound, so half a range would silently be no range.
    expect(pubmedSearchUrl({ query: "x", from: "2026/01/01" }, NOBODY)).not.toContain("mindate");
    const both = pubmedSearchUrl({ query: "x", from: "2026/01/01", to: "2026/12/31" }, NOBODY);
    expect(both).toContain("mindate=2026%2F01%2F01");
    expect(both).toContain("maxdate=2026%2F12%2F31");
  });

  it("only ever puts digits in a summary URL", () => {
    const url = pubmedSummaryUrl(["29562234", "../../etc/passwd", "1;DROP", "31234567"], NOBODY);
    expect(url).toContain("id=29562234,31234567");
    expect(url).not.toContain("passwd");
  });
});

describe("DOIs as people paste them", () => {
  it("strips the prefixes a browser and a citation add", () => {
    for (const raw of [
      "10.1038/nature26140",
      "https://doi.org/10.1038/nature26140",
      "http://dx.doi.org/10.1038/nature26140",
      "doi: 10.1038/nature26140",
      "  10.1038/nature26140  ",
    ]) {
      expect(normaliseDoi(raw), raw).toBe("10.1038/nature26140");
    }
  });

  it("recognises a DOI through those same prefixes", () => {
    expect(looksLikeDoi("https://doi.org/10.1038/nature26140")).toBe(true);
    expect(looksLikeDoi("29562234")).toBe(false);
    expect(looksLikeDoi("heart failure")).toBe(false);
  });

  it("puts the normalised DOI in the query, not the pasted URL", () => {
    const url = pubmedDoiUrl("https://doi.org/10.1038/nature26140", NOBODY);
    expect(url).toContain(encodeURIComponent("10.1038/nature26140[doi]"));
    expect(url).not.toContain("doi.org");
  });

  it("knows a PMID from anything else", () => {
    expect(isPmid("29562234")).toBe(true);
    expect(isPmid("PMID29562234")).toBe(false);
    expect(isPmid("")).toBe(false);
  });
});

describe("parsing a real search response", () => {
  it("reads the ids, the total and how PubMed understood the query", () => {
    const result = parsePubmedSearch(PUBMED_SEARCH);
    expect(result).not.toHaveProperty("why");
    if ("why" in result) return;
    expect(result.ids).toHaveLength(5);
    expect(result.ids.every(isPmid)).toBe(true);
    expect(result.total).toBeGreaterThan(1000);
    expect(result.translation).toContain("MeSH Terms");
  });

  it("surfaces a quoted phrase PubMed threw away", () => {
    // The captured response is the trap: PubMed did not return nothing, it
    // dropped the phrase and returned 25 unrelated papers. Without this
    // warning the results look like an answer to the question that was asked.
    const result = parsePubmedSearch(PUBMED_SEARCH_PHRASE_DROPPED);
    if ("why" in result) throw new Error("expected a result");
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("found no match for the phrase");
  });

  it("reports a body that is not JSON as such", () => {
    expect(parsePubmedSearch("<html>502 Bad Gateway</html>")).toEqual({
      why: "PubMed replied with something that is not JSON.",
    });
  });

  it("reports JSON without a result", () => {
    expect(parsePubmedSearch('{"error":"API rate limit exceeded"}')).toEqual({
      why: "PubMed said: API rate limit exceeded",
    });
  });
});

describe("parsing real summary records", () => {
  it("reads the fields a publication note needs", () => {
    const records = parsePubmedSummaries(PUBMED_SUMMARY);
    if ("why" in records) throw new Error("expected records");
    const nature = records.find((r) => r.pmid === "29562234");
    expect(nature).toBeDefined();
    expect(nature?.title).toBe("The protein histidine phosphatase LHPP is a tumour suppressor");
    expect(nature?.journal).toBe("Nature");
    expect(nature?.fullJournal).toBe("Nature");
    expect(nature?.doi).toBe("10.1038/nature26140");
    expect(nature?.year).toBe("2018");
    expect(nature?.volume).toBe("555");
    expect(nature?.authors[0]).toBe("Hindupur SK");
  });

  it("drops PubMed's trailing full stop from the title", () => {
    const records = parsePubmedSummaries(PUBMED_SUMMARY);
    if ("why" in records) throw new Error("expected records");
    for (const record of records) expect(record.title.endsWith(".")).toBe(false);
  });

  it("skips an id PubMed refused rather than emitting a blank record", () => {
    const records = parsePubmedSummaries(PUBMED_SUMMARY_WITH_ERROR);
    if ("why" in records) throw new Error("expected records");
    // The fixture asked for two ids and one came back as `{ uid, error }`.
    expect(records.map((r) => r.pmid)).toEqual(["29562234"]);
  });

  it("survives fields that are missing or the wrong type", () => {
    const odd = JSON.stringify({
      result: {
        uids: ["1"],
        "1": { uid: "1", title: null, authors: "not an array", articleids: 7, pubdate: 42 },
      },
    });
    const records = parsePubmedSummaries(odd);
    if ("why" in records) throw new Error("expected records");
    expect(records[0]).toMatchObject({ pmid: "1", title: "", authors: [], doi: "", year: "" });
  });
});

describe("proposing fields onto a publication note", () => {
  const record: PubmedRecord = {
    pmid: "29562234",
    title: "The protein histidine phosphatase LHPP is a tumour suppressor",
    journal: "Nature",
    fullJournal: "Nature Reviews",
    pubdate: "2018 Mar 29",
    year: "2018",
    authors: ["Hindupur SK", "Hall MN"],
    volume: "555",
    issue: "7698",
    pages: "678-682",
    doi: "10.1038/nature26140",
    pubtypes: ["Journal Article"],
  };

  it("proposes only what the note does not already say", () => {
    const proposals = proposeFields(record, { doi: "10.1038/nature26140", pmid: "" });
    expect(proposals.map((p) => p.field)).toEqual(["title", "journal", "pmid", "year"]);
  });

  it("marks a disagreement as a conflict rather than overwriting quietly", () => {
    const proposals = proposeFields(record, { journal: "The Lancet" });
    const journal = proposals.find((p) => p.field === "journal");
    expect(journal).toMatchObject({ current: "The Lancet", conflict: true });
  });

  it("does not mark filling an empty field as a conflict", () => {
    const proposals = proposeFields(record, { journal: "" });
    expect(proposals.find((p) => p.field === "journal")?.conflict).toBe(false);
  });

  it("prefers the full journal name over the abbreviation", () => {
    const proposals = proposeFields(record, {});
    expect(proposals.find((p) => p.field === "journal")?.proposed).toBe("Nature Reviews");
  });

  it("never proposes authors, position or corresponding", () => {
    // §5.4 stores authors as wikilinks into 30 People/; a fetch returns
    // surname-initial strings, and position is a fact about you that no
    // external record holds.
    const proposals = proposeFields(record, {});
    const fields = proposals.map((p) => p.field as string);
    expect(fields).not.toContain("authors");
    expect(fields).not.toContain("position");
    expect(fields).not.toContain("corresponding");
  });

  it("proposes nothing when the record adds nothing", () => {
    expect(
      proposeFields(record, {
        title: record.title,
        journal: "Nature Reviews",
        doi: record.doi,
        pmid: record.pmid,
        year: 2018,
      }),
    ).toEqual([]);
  });
});
