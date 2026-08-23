import { describe, expect, it } from "vitest";
import { parseParty } from "../comms/party";
import { parsePublication, type PublicationNote } from "./publication";
import {
  apaName,
  authorName,
  formatCitation,
  formatList,
  vancouverName,
  yearOf,
} from "./citation";

const name = (written: string) => authorName(parseParty(written));

const pub = (overrides: Record<string, unknown> = {}): PublicationNote =>
  parsePublication("85 Publications/PUB-1.md", {
    id: "PUB-2026-007",
    title: "Thirty-day readmission after heart failure",
    stage: "published",
    journal: "European Heart Journal",
    authors: ["[[Dr A Tan]]", "[[Dr B C Lim]]"],
    published: "2026-05-14",
    doi: "10.1093/eurheartj/ehaa001",
    ...overrides,
  });

describe("turning a vault name into a citation name", () => {
  it("reads the shape the vault contract itself uses", () => {
    // §5.1's own example is `[[Dr A Tan]]`.
    const tan = name("[[Dr A Tan]]");
    expect(tan.surname).toBe("Tan");
    expect(tan.initials).toBe("A");
    expect(tan.confident).toBe(true);
    expect(vancouverName(tan)).toBe("Tan A");
    expect(apaName(tan)).toBe("Tan, A.");
  });

  it("keeps several initials together", () => {
    expect(vancouverName(name("[[Dr B C Lim]]"))).toBe("Lim BC");
    expect(apaName(name("[[Dr B C Lim]]"))).toBe("Lim, B. C.");
  });

  it("strips a folder and an alias, because those are not the person", () => {
    expect(vancouverName(name("[[30 People/Dr A Tan|Tan]]"))).toBe("Tan A");
  });

  it("strips the honorifics a clinical vault actually uses", () => {
    for (const written of ["Prof A Tan", "Assoc Prof A Tan", "A/Prof A Tan", "Dr. A Tan", "Adj Prof A Tan"]) {
      expect(vancouverName(name(`[[${written}]]`))).toBe("Tan A");
    }
  });

  it("does not strip an honorific that is somebody's actual name", () => {
    // "Dr" leading is a title; a name that is only a title is a name.
    expect(name("[[Dr]]").surname).toBe("Dr");
  });

  it("drops a trailing qualification", () => {
    expect(vancouverName(name("[[Dr A Tan PhD]]"))).toBe("Tan A");
  });

  it("flags a full given name rather than guessing which end the surname is", () => {
    // "Siew Lim" could be Lim S or Siew L, and a CV that picks silently is
    // worse than one that asks.
    const guess = name("[[Dr Siew Lim]]");
    expect(guess.confident).toBe(false);
    expect(guess.given).toBe("Siew");
    expect(vancouverName(guess)).toBe("Lim S");
  });

  it("flags a one-word name instead of inventing initials", () => {
    const owner = name("[[Owner]]");
    expect(owner.surname).toBe("Owner");
    expect(owner.initials).toBe("");
    expect(owner.confident).toBe(false);
    expect(vancouverName(owner)).toBe("Owner");
  });
});

describe("which year a manuscript belongs to", () => {
  it("uses the publication date when there is one", () => {
    expect(yearOf(pub())).toEqual({ year: 2026, from: "published" });
  });

  it("falls back to when history says it went into print", () => {
    const year = yearOf(
      pub({
        published: undefined,
        history: [{ at: "2025-11-02", to: "accepted" }],
      }),
    );
    expect(year).toEqual({ year: 2025, from: "history" });
  });

  it("falls back to the submission year, and says that is what it did", () => {
    // "Grouped by year" quietly meaning "year we sent it" is the kind of thing
    // that gets noticed, so the source travels with the number.
    const year = yearOf(pub({ published: undefined, submitted: "2024-01-09", stage: "under-review" }));
    expect(year).toEqual({ year: 2024, from: "submitted" });
  });

  it("has no year for a paper that has never been dated", () => {
    expect(yearOf(pub({ published: undefined, submitted: undefined })).year).toBeNull();
  });
});

describe("Vancouver", () => {
  it("formats a complete reference", () => {
    const citation = formatCitation(
      pub({ volume: "47", issue: "12", pages: "1123-31" }),
      "vancouver",
    );
    expect(citation.text).toBe(
      "Tan A, Lim BC. Thirty-day readmission after heart failure. European Heart Journal. " +
        "2026;47(12):1123-31. doi:10.1093/eurheartj/ehaa001",
    );
  });

  it("omits what the note does not carry rather than printing undefined", () => {
    // A note written to §5.4 exactly has no volume and no pages.
    const citation = formatCitation(pub(), "vancouver");
    expect(citation.text).toBe(
      "Tan A, Lim BC. Thirty-day readmission after heart failure. European Heart Journal. " +
        "2026. doi:10.1093/eurheartj/ehaa001",
    );
  });

  it("prefers the abbreviated journal title when the note gives one", () => {
    expect(formatCitation(pub({ abbreviation: "Eur Heart J" })).text).toContain("Eur Heart J.");
  });

  it("truncates at six authors, as the style requires", () => {
    const authors = ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter) => `[[Dr ${letter} Tan]]`);
    expect(formatCitation(pub({ authors })).text).toContain("Tan F, et al.");
  });

  it("carries the names it was unsure about, so a list can flag them", () => {
    const citation = formatCitation(pub({ authors: ["[[Dr Siew Lim]]", "[[Dr A Tan]]"] }));
    expect(citation.uncertain.map((n) => n.raw)).toEqual(["Dr Siew Lim"]);
  });

  it("survives a note with no authors at all", () => {
    expect(formatCitation(pub({ authors: [] })).text).toBe(
      "Thirty-day readmission after heart failure. European Heart Journal. 2026. doi:10.1093/eurheartj/ehaa001",
    );
  });
});

describe("APA", () => {
  it("formats a complete reference", () => {
    const citation = formatCitation(pub({ volume: "47", issue: "12", pages: "1123-31" }), "apa");
    expect(citation.text).toBe(
      "Tan, A. & Lim, B. C. (2026). Thirty-day readmission after heart failure. " +
        "European Heart Journal, 47(12), 1123-31. https://doi.org/10.1093/eurheartj/ehaa001",
    );
  });

  it("says a paper is in progress rather than inventing a year", () => {
    expect(
      formatCitation(pub({ published: undefined, submitted: undefined }), "apa").text,
    ).toContain("(in progress)");
  });
});

describe("the list", () => {
  const listable = [
    pub({ id: "a", title: "Alpha", published: "2026-01-02", scdb_supported: true }),
    pub({ id: "b", title: "Beta", published: "2025-06-02", scdb_supported: false }),
    pub({ id: "c", title: "Gamma", published: "2026-09-02", scdb_supported: true }),
    pub({ id: "d", title: "Draft", stage: "drafting", published: undefined, submitted: undefined }),
  ];

  it("groups by year, newest first", () => {
    const groups = formatList(listable);
    expect(groups.map((group) => group.year)).toEqual([2026, 2025]);
    expect(groups[0]?.citations).toHaveLength(2);
  });

  it("leaves unpublished work out, because a draft is not a publication", () => {
    const titles = formatList(listable).flatMap((group) =>
      group.citations.map((citation) => citation.publication.title),
    );
    expect(titles).not.toContain("Draft");
  });

  it("cuts to SCDB-supported work for the funding committee", () => {
    const titles = formatList(listable, { scdbOnly: true }).flatMap((group) =>
      group.citations.map((citation) => citation.publication.title),
    );
    expect(titles).toEqual(["Alpha", "Gamma"]);
  });

  it("includes what the caller asks for when it asks for more", () => {
    const groups = formatList(listable, { stages: ["drafting"] });
    expect(groups[0]?.citations[0]?.publication.title).toBe("Draft");
    expect(groups[0]?.year).toBeNull();
  });

  it("orders within a year stably, so the list diffs", () => {
    const groups = formatList(listable);
    const first = groups[0]!.citations.map((citation) => citation.publication.title);
    const again = formatList([...listable].reverse())[0]!.citations.map(
      (citation) => citation.publication.title,
    );
    expect(first).toEqual(again);
  });
});
