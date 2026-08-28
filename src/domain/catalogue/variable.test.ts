import { describe, expect, it } from "vitest";
import {
  currentDefinition,
  dataTypeLabel,
  parseCoding,
  parseVariable,
  refMatchesVariable,
  refTarget,
  refVersion,
  variableLabel,
  versionRef,
} from "./variable";

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "variable",
    id: "VAR-LVEF",
    label: "Left ventricular ejection fraction",
    domain: "echo",
    data_type: "numeric",
    units: "%",
    valid_range: [0, 100],
    definition: "Biplane Simpson's.",
    version: 1,
    identifier: false,
    ...over,
  };
}

describe("parseVariable", () => {
  it("reads the shape §5.8 documents", () => {
    const variable = parseVariable("87 Catalogue/VAR-LVEF.md", raw({ collected_in: ["[[EuroHeart]]"] }));
    expect({
      id: variable.id,
      dataType: variable.dataType,
      units: variable.units,
      range: variable.validRange,
      collectedIn: variable.collectedIn,
      problems: variable.problems,
    }).toEqual({
      id: "VAR-LVEF",
      dataType: "numeric",
      units: "%",
      range: [0, 100],
      collectedIn: ["[[EuroHeart]]"],
      problems: [],
    });
  });

  it("refuses a version that is not a whole number, rather than coercing it", () => {
    // A policy version is a string because the issuer prints "2026-A". A
    // catalogue version is ours, and `supersedes: VAR-LVEF@2` only parses as a
    // chain if it is an integer.
    const variable = parseVariable("x.md", raw({ version: "3.1" }));
    expect(variable.version).toBe(0);
    expect(variable.problems.join(" ")).toContain("not a whole number");
  });

  it("flags an identifier with no recorded justification", () => {
    const variable = parseVariable("x.md", raw({ identifier: true }));
    expect(variable.identifier).toBe(true);
    expect(variable.problems.join(" ")).toContain("justification");
  });

  it("accepts a justified identifier without complaint", () => {
    const variable = parseVariable(
      "x.md",
      raw({ identifier: true, justification: "Linkage to the national registry, per DSRB-2026-0142." }),
    );
    expect(variable.problems).toEqual([]);
  });

  it("flags a categorical variable with no coding", () => {
    const variable = parseVariable("x.md", raw({ data_type: "categorical", valid_range: undefined }));
    expect(variable.problems.join(" ")).toContain("no `coding`");
  });

  it("flags a range that runs backwards", () => {
    const variable = parseVariable("x.md", raw({ valid_range: [100, 0] }));
    expect(variable.validRange).toBeNull();
    expect(variable.problems.join(" ")).toContain("runs backwards");
  });

  it("wants a date and a reason once past version 1", () => {
    const variable = parseVariable("x.md", raw({ version: 3 }));
    const said = variable.problems.join(" ");
    expect(said).toContain("`changed`");
    expect(said).toContain("`change_reason`");
  });

  it("sorts history oldest first however the note was written", () => {
    const variable = parseVariable(
      "x.md",
      raw({
        version: 3,
        changed: "2026-02-01",
        change_reason: "ESC 2025",
        history: [
          { version: 2, on: "2023-07-01", definition: "Second", reason: "b" },
          { version: 1, on: "2019-04-01", definition: "First", reason: "a" },
        ],
      }),
    );
    expect(variable.history.map((record) => record.version)).toEqual([1, 2]);
  });

  it("keeps an unstated identifier flag on a history entry as null, not false", () => {
    // "The note never said" and "the note said no" are different answers to a
    // governance question, and collapsing them would invent the second.
    const variable = parseVariable(
      "x.md",
      raw({ version: 2, changed: "2026-01-01", change_reason: "r", history: [{ version: 1, definition: "First" }] }),
    );
    expect(variable.history[0]?.identifier).toBeUndefined();
  });
});

describe("parseCoding", () => {
  it("reads the mapping form", () => {
    expect(parseCoding({ 1: "Mild", 2: "Severe" }, [])).toEqual([
      { code: "1", label: "Mild" },
      { code: "2", label: "Severe" },
    ]);
  });

  it("reads REDCap's own choice string, because that is what gets pasted", () => {
    expect(parseCoding("1, Mild | 2, Severe", [])).toEqual([
      { code: "1", label: "Mild" },
      { code: "2", label: "Severe" },
    ]);
  });

  it("keeps a label containing a comma whole", () => {
    expect(parseCoding("1, Mild, resolving", [])).toEqual([{ code: "1", label: "Mild, resolving" }]);
  });

  it("reports a choice with no comma rather than guessing", () => {
    const problems: string[] = [];
    expect(parseCoding("1 Mild", problems)).toEqual([]);
    expect(problems.join(" ")).toContain("no comma");
  });
});

describe("refs", () => {
  it("strips brackets, alias, folder and version", () => {
    expect(refTarget("[[87 Catalogue/VAR-LVEF@2|LVEF]]")).toBe("87 catalogue/var-lvef");
    expect(refTarget("VAR-LVEF")).toBe("var-lvef");
  });

  it("reads the version a ref named, and only a numeric one", () => {
    expect(refVersion("[[VAR-LVEF@2]]")).toBe(2);
    expect(refVersion("VAR-LVEF")).toBeNull();
    expect(refVersion("VAR-LVEF@draft")).toBeNull();
  });

  it("matches a ref written as id, filename, path or wikilink", () => {
    const variable = parseVariable("87 Catalogue/VAR-LVEF.md", raw());
    for (const ref of [
      "VAR-LVEF",
      "[[VAR-LVEF]]",
      "[[87 Catalogue/VAR-LVEF]]",
      "[[VAR-LVEF@2]]",
      "Left ventricular ejection fraction",
    ]) {
      expect({ ref, matches: refMatchesVariable(ref, variable) }).toEqual({ ref, matches: true });
    }
    expect(refMatchesVariable("VAR-EGFR", variable)).toBe(false);
  });
});

describe("labels", () => {
  it("names a version the way `supersedes` does", () => {
    expect(versionRef("VAR-LVEF", 2)).toBe("VAR-LVEF@2");
    expect(versionRef("", 2)).toBe("");
  });

  it("falls back through id, label and path", () => {
    expect(variableLabel(parseVariable("x.md", raw()))).toBe(
      "VAR-LVEF — Left ventricular ejection fraction",
    );
    expect(variableLabel(parseVariable("87 Catalogue/x.md", { type: "variable" }))).toBe(
      "87 Catalogue/x.md",
    );
  });

  it("shows an unknown data type as written rather than blank", () => {
    expect(dataTypeLabel("ordinal")).toBe("ordinal");
    expect(dataTypeLabel("")).toBe("Unstated");
  });

  it("reads the current definition as the head of the chain", () => {
    expect(currentDefinition(parseVariable("x.md", raw()))).toEqual({
      definition: "Biplane Simpson's.",
      dataType: "numeric",
      units: "%",
      validRange: [0, 100],
      coding: [],
      identifier: false,
    });
  });
});
