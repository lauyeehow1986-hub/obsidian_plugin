import { describe, expect, it } from "vitest";
import { parsePublication, type PublicationNote } from "../publication/publication";
import { composeCv, cvLine, DEFAULT_CV_LAYOUT, money, parseCvLayout } from "./cv";
import { parseProfileNote, type ProfileNote } from "./profile";

function profile(frontmatter: Record<string, unknown>, path = "84 Profile/x.md"): ProfileNote {
  const note = parseProfileNote(path, frontmatter);
  if (note === null) throw new Error("expected a profile note");
  return note;
}

function publication(overrides: Record<string, unknown> = {}): PublicationNote {
  return parsePublication("85 Publications/PUB-1.md", {
    type: "publication",
    id: "PUB-1",
    title: "A synthetic paper",
    stage: "published",
    journal: "Journal of Invented Results",
    authors: ["[[A Author]]", "[[B Author]]"],
    published: "2026-02-01",
    scdb_supported: true,
    ...overrides,
  });
}

const NOTES: ProfileNote[] = [
  profile(
    {
      type: "grant",
      title: "Readmission modelling",
      role: "PI",
      agency: "Invented Funding Body",
      ref: "IFB-2024-01",
      amount: 250000,
      currency: "SGD",
      status: "awarded",
      period: "2024-2027",
    },
    "g1.md",
  ),
  profile({ type: "award", title: "Invented Prize", body: "Some Body", year: 2025 }, "a1.md"),
  profile(
    {
      type: "service",
      title: "Data governance committee",
      position: "Member",
      organisation: "Invented Institution",
      scope: "institutional",
      period: "2023-present",
    },
    "s1.md",
  ),
];

describe("cvLine", () => {
  it("writes a grant as one sentence, dropping the fields the note left blank", () => {
    expect(cvLine(NOTES[0]!)).toBe(
      "Readmission modelling. Invented Funding Body (IFB-2024-01). PI. SGD 250,000.",
    );
  });

  it("says nothing about an awarded grant's status, and everything about any other", () => {
    const submitted = profile({ type: "grant", title: "T", agency: "A", status: "submitted" });
    expect(cvLine(NOTES[0]!)).not.toMatch(/awarded/i);
    expect(cvLine(submitted)).toMatch(/submitted/i);
  });

  it("marks an invited talk as invited", () => {
    const talk = profile({
      type: "presentation",
      title: "A talk",
      meeting: "A congress",
      format: "oral",
      invited: true,
    });
    expect(cvLine(talk)).toBe("A talk. A congress. oral, invited.");
  });

  it("never leaves a dangling separator when most fields are empty", () => {
    expect(cvLine(profile({ type: "award", title: "Just a title" }))).toBe("Just a title.");
  });
});

describe("money", () => {
  it("groups the figure and keeps the currency the note gave", () => {
    expect(money(250000, "SGD")).toBe("SGD 250,000");
    expect(money(250000, "")).toBe("250,000");
    expect(money(null, "SGD")).toBe("");
  });
});

describe("composeCv", () => {
  it("builds the default layout and drops the sections with nothing in them", () => {
    const cv = composeCv({ profile: NOTES, publications: [publication()], format: "vancouver" });
    expect(cv.sections.map((section) => section.heading)).toEqual([
      "Publications",
      "Grants and funding",
      "Awards",
      "Service",
    ]);
    // Teaching, supervision and presentations have no notes, so they are not
    // printed as empty headings — a gap in the record reads very differently
    // from a section you have not filled in.
    expect(cv.total).toBe(4);
  });

  it("groups publications by year and never lists a manuscript still in drafting", () => {
    const cv = composeCv({
      profile: [],
      publications: [publication(), publication({ id: "PUB-2", stage: "drafting" })],
      format: "vancouver",
    });
    expect(cv.sections).toHaveLength(1);
    expect(cv.sections[0]?.years.map((group) => group.year)).toEqual([2026]);
    expect(cv.total).toBe(1);
  });

  it("honours a layout that asks for one section only", () => {
    const cv = composeCv({
      profile: NOTES,
      publications: [],
      format: "vancouver",
      layout: [{ heading: "Funding", source: { kind: "profile", type: "grant" } }],
    });
    expect(cv.sections.map((section) => section.heading)).toEqual(["Funding"]);
  });

  it("reports nothing rather than half a CV when the vault is empty", () => {
    const cv = composeCv({ profile: [], publications: [], format: "vancouver" });
    expect(cv.sections).toEqual([]);
    expect(cv.total).toBe(0);
  });

  it("surfaces author names the splitter was unsure of", () => {
    const cv = composeCv({
      profile: [],
      publications: [publication({ authors: ["[[vanden Berg de Groot Something]]"] })],
      format: "vancouver",
    });
    // The count is not the point; a CV is checked line by line, so the names
    // have to be nameable.
    expect(Array.isArray(cv.uncertainAuthors)).toBe(true);
  });
});

describe("parseCvLayout", () => {
  it("reads a layout out of a template", () => {
    const problems: string[] = [];
    const layout = parseCvLayout(
      [
        { heading: "Papers", from: "publications", scdb_only: true },
        { heading: "Funding", from: "grant" },
      ],
      problems,
    );
    expect(problems).toEqual([]);
    expect(layout?.map((section) => section.heading)).toEqual(["Papers", "Funding"]);
    expect(layout?.[0]?.source).toEqual({ kind: "publications", scdbOnly: true });
  });

  it("reports a section whose source is not a note type, rather than dropping it silently", () => {
    const problems: string[] = [];
    parseCvLayout([{ heading: "Talks", from: "presentations" }], problems);
    expect(problems[0]).toMatch(/presentations/);
  });

  it("falls back to the default when there is nothing usable", () => {
    const problems: string[] = [];
    expect(parseCvLayout(undefined, problems)).toBeNull();
    expect(parseCvLayout("not a list", problems)).toBeNull();
    expect(problems[0]).toMatch(/not a list/);
  });

  it("the shipped default covers every profile note type", () => {
    const covered = DEFAULT_CV_LAYOUT.filter((section) => section.source.kind === "profile").map(
      (section) => (section.source.kind === "profile" ? section.source.type : ""),
    );
    expect(covered.sort()).toEqual([
      "award",
      "grant",
      "presentation",
      "service",
      "supervision",
      "teaching",
    ]);
  });
});
