import { describe, expect, it } from "vitest";
import {
  clauseMatches,
  sectionKey,
  sectionLabel,
  splitClause,
  splitSections,
  stripFrontmatter,
} from "./sections";

describe("stripFrontmatter", () => {
  it("drops a leading block and keeps the body", () => {
    expect(stripFrontmatter("---\ntype: policy\n---\n# Title\n\nBody")).toBe("# Title\n\nBody");
  });

  it("leaves a document that merely contains a rule alone", () => {
    expect(stripFrontmatter("# Title\n\n---\n\nMore")).toBe("# Title\n\n---\n\nMore");
  });

  it("normalises CRLF, so a Windows export is not a whole-file change", () => {
    expect(stripFrontmatter("a\r\nb\r\n")).toBe("a\nb\n");
  });
});

describe("splitClause", () => {
  it.each([
    ["5 Scope", "5", "Scope"],
    ["5.2 Onward transfer", "5.2", "Onward transfer"],
    ["5.2.1 Sub", "5.2.1", "Sub"],
    ["§5.2 Onward transfer", "5.2", "Onward transfer"],
    ["5.2) Onward transfer", "5.2", "Onward transfer"],
  ])("reads %s as clause %s", (heading, clause, text) => {
    expect(splitClause(heading)).toEqual({ clause, text });
  });

  it("does not read a year as a clause number", () => {
    // "2026 review cycle" is a heading, not clause 2026. Getting this wrong
    // would put a clause number in an impact report that appears nowhere in
    // the policy.
    expect(splitClause("2026 review cycle")).toEqual({ clause: "2026", text: "review cycle" });
  });

  it("leaves an unnumbered heading unnumbered", () => {
    expect(splitClause("Definitions")).toEqual({ clause: "", text: "Definitions" });
  });
});

const DOC = [
  "Preamble text.",
  "",
  "# 1 Purpose",
  "",
  "Why this exists.",
  "",
  "## 5.2 Onward transfer",
  "",
  "No transfer without a DUA.",
  "",
  "### Definitions",
  "",
  "Words.",
].join("\n");

describe("splitSections", () => {
  it("keeps the preamble when there is one", () => {
    const [first] = splitSections(DOC);
    expect(first?.level).toBe(0);
    expect(first?.lines.join("\n").trim()).toBe("Preamble text.");
  });

  it("drops an empty preamble rather than reporting a phantom section", () => {
    expect(splitSections("# 1 Purpose\n\nWhy.")).toHaveLength(1);
  });

  it("reads clause numbers off headings", () => {
    const clauses = splitSections(DOC).map((section) => section.clause);
    expect(clauses).toEqual(["", "1", "5.2", ""]);
  });

  it("never invents a number for an unnumbered child", () => {
    // `### Definitions` under `## 5.2` is NOT clause 5.2.1.
    const definitions = splitSections(DOC).find((section) => section.heading === "Definitions");
    expect(definitions?.clause).toBe("");
    expect(definitions?.path).toEqual(["Purpose", "Onward transfer"]);
  });

  it("reads a heading indented by up to three spaces, as markdown does", () => {
    // A policy pasted out of a word processor arrives indented. Missing the
    // headings collapses the document into one section, which turns a two-line
    // revision into "everything changed".
    const indented = DOC.split("\n")
      .map((line) => (line.trim() === "" ? line : `  ${line}`))
      .join("\n");
    expect(splitSections(indented).map((section) => section.clause)).toEqual(["", "1", "5.2", ""]);
  });

  it("does not read a # inside a fenced block as a heading", () => {
    const withFence = ["# 1 Purpose", "", "```bash", "# not a heading", "```", "", "End."].join(
      "\n",
    );
    expect(splitSections(withFence)).toHaveLength(1);
  });
});

describe("sectionKey", () => {
  it("identifies a numbered section by its clause, so a rename does not orphan it", () => {
    const [before] = splitSections("## 5.2 Onward transfer\n\nText.");
    const [after] = splitSections("## 5.2 Transfer to third parties\n\nText.");
    expect(sectionKey(before!)).toBe(sectionKey(after!));
  });

  it("falls back to the heading path when there is no number", () => {
    const [section] = splitSections("## Definitions\n\nWords.");
    expect(sectionKey(section!)).toBe("path:definitions");
  });
});

describe("sectionLabel", () => {
  it("puts the clause in front of the heading", () => {
    const [section] = splitSections("## 5.2 Onward transfer\n\nText.");
    expect(sectionLabel(section!)).toBe("5.2 Onward transfer");
  });
});

describe("clauseMatches", () => {
  it("matches a clause against itself", () => {
    expect(clauseMatches("5.2", "5.2")).toBe(true);
  });

  it("reaches a subclause from a change recorded at the parent", () => {
    expect(clauseMatches("5.2.1", "5.2")).toBe(true);
  });

  it("reaches a parent from a change recorded at the subclause", () => {
    expect(clauseMatches("5.2", "5.2.1")).toBe(true);
  });

  it("does not match a clause that merely shares digits", () => {
    // 5.2 and 5.21 are different rules; a prefix test without the dot would
    // flag the wrong dependants.
    expect(clauseMatches("5.2", "5.21")).toBe(false);
  });

  it("never matches when either side is silent", () => {
    expect(clauseMatches("", "5.2")).toBe(false);
    expect(clauseMatches("5.2", "")).toBe(false);
  });
});
