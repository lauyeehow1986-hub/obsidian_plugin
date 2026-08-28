import { describe, expect, it } from "vitest";
import { buildCatalogue, searchCatalogue } from "./register";
import type { Citation } from "./dependants";
import { parseVariable, type VariableNote } from "./variable";

function variable(id: string, over: Record<string, unknown> = {}): VariableNote {
  return parseVariable(`87 Catalogue/${id}.md`, {
    type: "variable",
    id,
    label: id,
    domain: "echo",
    data_type: "numeric",
    definition: "d",
    version: 1,
    ...over,
  });
}

const run = (ref: string, version: number | null): Citation => ({
  path: "94 Runs/RUN-1.md",
  type: "run",
  id: "RUN-1",
  title: "",
  ref,
  field: "variables",
  version,
});

describe("buildCatalogue", () => {
  it("groups by domain and sorts inside each group", () => {
    const catalogue = buildCatalogue({
      variables: [
        variable("VAR-BNP", { domain: "labs" }),
        variable("VAR-LVEF"),
        variable("VAR-AVA"),
      ],
      citations: [],
    });
    expect(catalogue.groups.map((group) => group.label)).toEqual(["echo", "labs"]);
    expect(catalogue.groups[0]?.rows.map((row) => row.variable.id)).toEqual(["VAR-AVA", "VAR-LVEF"]);
  });

  it("labels the ungrouped rather than showing an empty heading", () => {
    const catalogue = buildCatalogue({ variables: [variable("VAR-X", { domain: undefined })], citations: [] });
    expect(catalogue.groups[0]?.label).toBe("No domain set");
  });

  it("counts what an HOD is asked about the catalogue", () => {
    const catalogue = buildCatalogue({
      variables: [
        variable("VAR-NRIC", { identifier: true }),
        variable("VAR-DOB", { identifier: true, justification: "Age at index, per DSRB scope." }),
        variable("VAR-LVEF", { version: 3, changed: "2026-02-01", change_reason: "r", supersedes: "VAR-LVEF@2", history: [{ version: 1, on: "2019-04-01", definition: "a", reason: "r" }, { version: 2, on: "2023-07-01", definition: "b", reason: "r" }] }),
      ],
      citations: [run("[[VAR-LVEF@2]]", 2), run("[[VAR-EGFR]]", null)],
    });
    expect(catalogue.summary).toMatchObject({
      total: 3,
      identifiers: 2,
      unjustified: 1,
      revised: 1,
      uncited: 2,
      stale: 1,
      orphans: 1,
    });
  });

  it("folds the chain problems into the row's own", () => {
    const row = buildCatalogue({
      variables: [variable("VAR-LVEF", { version: 2, changed: "2026-02-01", change_reason: "r" })],
      citations: [],
    }).rows[0]!;
    expect(row.chain.join(" ")).toContain("only the version number survives");
    expect(row.problems.length).toBeGreaterThanOrEqual(row.chain.length);
  });
});

describe("searchCatalogue", () => {
  const rows = buildCatalogue({
    variables: [
      variable("VAR-LVEF", { label: "Left ventricular ejection fraction", units: "%" }),
      variable("VAR-NYHA", { data_type: "categorical", coding: "1, Class I | 2, Class II", domain: "clinical" }),
    ],
    citations: [],
  }).rows;

  it("matches id, label, units and coding labels", () => {
    expect(searchCatalogue(rows, "ejection").map((row) => row.variable.id)).toEqual(["VAR-LVEF"]);
    expect(searchCatalogue(rows, "class ii").map((row) => row.variable.id)).toEqual(["VAR-NYHA"]);
    expect(searchCatalogue(rows, "clinical").map((row) => row.variable.id)).toEqual(["VAR-NYHA"]);
  });

  it("returns everything for an empty query", () => {
    expect(searchCatalogue(rows, "  ")).toHaveLength(2);
  });
});
