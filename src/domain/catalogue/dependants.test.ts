import { describe, expect, it } from "vitest";
import { buildDependants, noteCitations, staleCitations, type Citation } from "./dependants";
import { parseVariable, type VariableNote } from "./variable";

function variable(id: string, over: Record<string, unknown> = {}): VariableNote {
  return parseVariable(`87 Catalogue/${id}.md`, {
    type: "variable",
    id,
    label: id,
    definition: "d",
    version: 1,
    ...over,
  });
}

function citation(over: Partial<Citation> = {}): Citation {
  return {
    path: "94 Runs/RUN-1.md",
    type: "run",
    id: "RUN-1",
    title: "",
    ref: "[[VAR-LVEF]]",
    field: "variables",
    version: null,
    ...over,
  };
}

describe("noteCitations", () => {
  it("reads the `variables:` list §5.12 puts on a run record", () => {
    const citations = noteCitations("94 Runs/RUN-1.md", "run", {
      id: "RUN-1",
      variables: ["[[VAR-LVEF]]", "[[VAR-BNP@2]]"],
    });
    expect(citations.map((entry) => [entry.ref, entry.version])).toEqual([
      ["[[VAR-LVEF]]", null],
      ["[[VAR-BNP@2]]", 2],
    ]);
  });

  it("accepts a single ref as well as a list", () => {
    expect(noteCitations("x.md", "script-doc", { variables: "VAR-LVEF" })).toHaveLength(1);
  });

  it("finds nothing on a note that cites nothing", () => {
    expect(noteCitations("x.md", "scdb-request", { id: "REQ-1" })).toEqual([]);
  });
});

describe("buildDependants", () => {
  it("groups citations by the kind of note doing the citing", () => {
    const map = buildDependants({
      variables: [variable("VAR-LVEF")],
      citations: [
        citation(),
        citation({ path: "50 Scripts/S.md", type: "script-doc", id: "SCRIPT-1" }),
        citation({ path: "10 Requests/R.md", type: "scdb-request", id: "REQ-1" }),
      ],
    });
    const entry = map.byVariable.get("87 Catalogue/VAR-LVEF.md")!;
    expect(entry.groups.map((group) => group.kind)).toEqual(["request", "script", "run"]);
    expect(entry.total).toBe(3);
  });

  it("folds the variable's own collected_in and source_form into the map", () => {
    // Declarable from both ends, the same as a policy edge: a study does not
    // have to know it collects a variable for the variable to say so.
    const map = buildDependants({
      variables: [variable("VAR-LVEF", { collected_in: ["[[EuroHeart]]"], source_form: "[[FORM-echo]]" })],
      citations: [],
    });
    const entry = map.byVariable.get("87 Catalogue/VAR-LVEF.md")!;
    expect(entry.groups.map((group) => group.kind)).toEqual(["study", "form"]);
  });

  it("flags a citation that named a version the catalogue has moved past", () => {
    const map = buildDependants({
      variables: [variable("VAR-LVEF", { version: 3, changed: "2026-02-01", change_reason: "r" })],
      citations: [citation({ ref: "[[VAR-LVEF@2]]", version: 2 })],
    });
    const rows = staleCitations(map);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.citation.id).toBe("RUN-1");
    expect(map.byVariable.get("87 Catalogue/VAR-LVEF.md")?.stale).toBe(1);
  });

  it("does not call a citation of the current version stale", () => {
    const map = buildDependants({
      variables: [variable("VAR-LVEF", { version: 2, changed: "2026-02-01", change_reason: "r" })],
      citations: [citation({ ref: "[[VAR-LVEF@2]]", version: 2 })],
    });
    expect(staleCitations(map)).toEqual([]);
  });

  it("counts an unversioned citation separately from a stale one", () => {
    // They call for different actions: one is out of date, the other never
    // said which definition it meant.
    const map = buildDependants({
      variables: [variable("VAR-LVEF", { version: 3, changed: "2026-02-01", change_reason: "r" })],
      citations: [citation(), citation({ path: "94 Runs/RUN-2.md", ref: "[[VAR-LVEF@1]]", version: 1 })],
    });
    const entry = map.byVariable.get("87 Catalogue/VAR-LVEF.md")!;
    expect({ stale: entry.stale, unversioned: entry.unversioned }).toEqual({ stale: 1, unversioned: 1 });
  });

  it("reports a citation of a variable the catalogue does not hold", () => {
    const map = buildDependants({
      variables: [variable("VAR-LVEF")],
      citations: [citation({ ref: "[[VAR-EGFR]]" })],
    });
    expect(map.orphans.map((entry) => entry.ref)).toEqual(["[[VAR-EGFR]]"]);
    expect(map.byVariable.get("87 Catalogue/VAR-LVEF.md")?.total).toBe(0);
  });

  it("lists a variable nothing cites", () => {
    const map = buildDependants({ variables: [variable("VAR-LVEF")], citations: [] });
    expect(map.uncited.map((entry) => entry.id)).toEqual(["VAR-LVEF"]);
  });

  it("never counts a variable note as its own dependant", () => {
    const map = buildDependants({
      variables: [variable("VAR-LVEF")],
      citations: [citation({ path: "87 Catalogue/VAR-LVEF.md", type: "variable" })],
    });
    expect(map.byVariable.get("87 Catalogue/VAR-LVEF.md")?.total).toBe(0);
  });
});
