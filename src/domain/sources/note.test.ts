import { describe, expect, it } from "vitest";
import type { TrialRecord } from "./ctgov";
import { buildSourceBriefing, fileSafe, SOURCE_BRIEFING_TYPE } from "./note";
import type { PubmedRecord } from "./pubmed";

const paper: PubmedRecord = {
  pmid: "29562234",
  title: "The protein histidine phosphatase LHPP is a tumour suppressor",
  journal: "Nature",
  fullJournal: "Nature",
  pubdate: "2018 Mar 29",
  year: "2018",
  authors: ["A", "B", "C", "D", "E", "F", "G", "H"],
  volume: "555",
  issue: "7698",
  pages: "678-682",
  doi: "10.1038/nature26140",
  pubtypes: ["Journal Article"],
};

const trial: TrialRecord = {
  nctId: "NCT06345521",
  title: "A registry platform for paediatric heart failure",
  status: "NOT_YET_RECRUITING",
  studyType: "OBSERVATIONAL",
  phases: [],
  enrolment: "100",
  sponsor: "A national centre",
  start: "2022-01-01",
  primaryCompletion: "2024-06-22",
  conditions: ["Heart Failure"],
  countries: ["China"],
};

const base = {
  query: "heart failure readmission",
  url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed",
  fetchedAt: "2026-08-29T14:03",
  date: "2026-08-29",
  total: 9710,
};

describe("the briefing note", () => {
  it("records where it came from and when", () => {
    // §5.1's argument applied to the literature: a list of papers with no date
    // and no query on it is a claim that cannot be checked.
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.frontmatter).toMatchObject({
      type: SOURCE_BRIEFING_TYPE,
      source: "pubmed",
      query: "heart failure readmission",
      host: "eutils.ncbi.nlm.nih.gov",
      fetched: "2026-08-29T14:03",
      total: 9710,
      kept: 1,
    });
    expect(built.body).toContain("Fetched 2026-08-29T14:03 from eutils.ncbi.nlm.nih.gov");
  });

  it("says how many matched against how many were kept", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.body).toContain("9,710");
    expect(built.body).toContain("**1**");
  });

  it("says plainly what it is not", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.body).toContain("not a systematic review");
  });

  it("renders a paper with its identifiers", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.body).toContain("### The protein histidine phosphatase LHPP");
    expect(built.body).toContain("[PMID 29562234](https://pubmed.ncbi.nlm.nih.gov/29562234/)");
    expect(built.body).toContain("doi 10.1038/nature26140");
    expect(built.body).toContain("555(7698):678-682");
  });

  it("truncates a long author list the way the publication list does", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.body).toContain("A, B, C, D, E, F, et al.");
  });

  it("renders a trial in words rather than the API's spelling", () => {
    const built = buildSourceBriefing({ ...base, source: "ctgov", trials: [trial], total: 417 });
    expect(built.body).toContain("Not yet recruiting");
    expect(built.body).not.toContain("NOT_YET_RECRUITING");
    expect(built.body).toContain("n = 100");
    expect(built.body).toContain("[NCT06345521](https://clinicaltrials.gov/study/NCT06345521)");
  });

  it("says so rather than looking broken when nothing was kept", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [] });
    expect(built.body).toContain("Nothing was kept");
    expect(built.frontmatter.kept).toBe(0);
  });
});

describe("what a fetched title cannot do to the note", () => {
  const hostile: PubmedRecord = {
    ...paper,
    title: "Outcomes ![[10 Requests/REQ-2026-014]] and [[Dr A Tan]]",
  };

  it("cannot embed a request note into the briefing", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [hostile] });
    expect(built.body).not.toMatch(/!\[\[/);
    expect(built.body).not.toContain("[[Dr A Tan]]");
    // The text is still there to read, just inert.
    expect(built.body).toContain("Dr A Tan");
  });

  it("cannot steer the PubMed link, which is built from digits", () => {
    const spoofed: PubmedRecord = { ...paper, pmid: "1 evil.example" };
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [spoofed] });
    expect(built.body).not.toContain("evil.example");
  });

  it("does not add backslashes to a heading, which already starts the line", () => {
    // `### ` is ours and comes first, so nothing in the title can open a
    // block. Escaping there would only put visible backslashes in front of a
    // perfectly ordinary title.
    const built = buildSourceBriefing({
      ...base,
      source: "pubmed",
      papers: [{ ...paper, title: "## A subheading" }],
    });
    expect(built.body).toContain("### ## A subheading");
  });

  it("keeps the journal in italics rather than escaping our own marker", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [paper] });
    expect(built.body).toContain("*Nature*");
    expect(built.body).not.toContain("\\*Nature*");
  });

  it("stores the query unescaped in frontmatter, which is YAML", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", query: "a [b] c", papers: [] });
    expect(built.frontmatter.query).toBe("a [b] c");
  });
});

describe("the filename", () => {
  it("carries the date, the source and the query", () => {
    const built = buildSourceBriefing({ ...base, source: "pubmed", papers: [] });
    expect(built.stem).toBe("2026-08-29 PubMed — heart failure readmission");
  });

  it("removes what a filename cannot hold", () => {
    expect(fileSafe('a/b\\c:d*e?f"g<h>i|j[k]#l^m')).toBe("a b c d e f g h i j k l m");
  });

  it("caps a pasted query rather than building an impossible path", () => {
    expect(fileSafe("x".repeat(400)).length).toBeLessThanOrEqual(61);
  });

  it("never returns an empty name", () => {
    expect(fileSafe("   ")).toBe("search");
    expect(fileSafe("///")).toBe("search");
  });
});
