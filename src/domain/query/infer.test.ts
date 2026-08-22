import { describe, expect, it } from "vitest";
import { flattenFrontmatter, inferFields, inferKind } from "./infer";

describe("flattening", () => {
  it("addresses nested frontmatter by a dotted path", () => {
    const flat = flattenFrontmatter({
      stage: "triage",
      governance: { identifiers: "indirect", irb_ref: "DSRB-1" },
    });
    expect(flat["governance.identifiers"]).toBe("indirect");
    // The container survives too, so `governance is not empty` still works.
    expect(flat["governance"]).toEqual({ identifiers: "indirect", irb_ref: "DSRB-1" });
  });

  it("leaves a list alone rather than exploding its indices", () => {
    const flat = flattenFrontmatter({ authors: ["[[A]]", "[[B]]"] });
    expect(flat["authors"]).toEqual(["[[A]]", "[[B]]"]);
    // `toHaveProperty` reads a dot as a path, so check the keys directly.
    expect(Object.keys(flat)).toEqual(["authors"]);
  });
});

describe("kind inference", () => {
  it("reads the obvious cases", () => {
    expect(inferKind(true)).toBe("boolean");
    expect(inferKind(42)).toBe("number");
    expect(inferKind("[[Dr A Tan]]")).toBe("link");
    expect(inferKind("2026-07-14")).toBe("date");
    expect(inferKind("under review")).toBe("text");
    expect(inferKind(["a"])).toBe("list");
  });

  it("does not turn a title that starts with a year into a date", () => {
    expect(inferKind("2026 readmission cohort")).toBe("text");
  });

  it("declines to guess from nothing", () => {
    expect(inferKind(null)).toBeNull();
    expect(inferKind(undefined)).toBeNull();
    // An empty list says nothing about what it would contain.
    expect(inferKind([])).toBeNull();
  });
});

describe("field inference", () => {
  it("collects fields across notes, not only the first", () => {
    const fields = inferFields([
      { type: "publication", title: "A", stage: "submitted" },
      { type: "publication", title: "B", doi: "10.1/x", open_access: true },
    ]);
    expect(fields.map((field) => field.id).sort()).toEqual([
      "doi",
      "open_access",
      "stage",
      "title",
    ]);
  });

  it("never offers `type` as a field — it is the selector, not a column", () => {
    expect(inferFields([{ type: "publication" }])).toEqual([]);
  });

  it("takes the kind of the first readable value, ignoring nulls before it", () => {
    const fields = inferFields([
      { type: "x", decision_due: null },
      { type: "x", decision_due: "2026-08-01" },
    ]);
    expect(fields[0]).toMatchObject({ id: "decision_due", kind: "date" });
  });

  it("labels a field the way a person would read it", () => {
    const fields = inferFields([{ type: "x", irb_expiry: "2027-03-31", "a.b_c": 1 }]);
    expect(fields.map((field) => field.label).sort()).toEqual(["B c", "Irb expiry"]);
  });

  it("stops sampling once it has seen enough notes", () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      index < 400 ? { type: "x", common: "yes" } : { type: "x", rare: "seen too late" },
    );
    expect(inferFields(many, 10).map((field) => field.id)).toEqual(["common"]);
  });
});
