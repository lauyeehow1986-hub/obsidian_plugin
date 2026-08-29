import { describe, expect, it } from "vitest";
import { parseVariable } from "../catalogue/variable";
import { buildScriptRegister, searchScripts } from "./register";
import { parseRunRecord } from "./runRecord";
import { parseScriptDoc } from "./scriptDoc";

const HASH = "ab".repeat(32);

function doc(id: string, over: Record<string, unknown> = {}) {
  return parseScriptDoc(`50 Scripts/${id}.md`, {
    type: "script-doc",
    id,
    title: `${id} build`,
    purpose: "Builds something.",
    language: "r",
    file: `50 Scripts/${id}.R`,
    file_hash: HASH,
    last_run: "2026-05-12",
    ...over,
  });
}

function run(script: string, over: Record<string, unknown> = {}) {
  return parseRunRecord(`94 Runs/RUN-${script}.md`, {
    type: "run",
    id: `RUN-${script}`,
    script: `[[${script}]]`,
    started: "2026-05-12T09:00",
    exit: "ok",
    script_hash: HASH,
    ...over,
  });
}

const lvef = parseVariable("87 Catalogue/VAR-LVEF.md", {
  type: "variable",
  id: "VAR-LVEF",
  definition: "d",
  version: 3,
  changed: "2026-06-01",
  change_reason: "r",
});

describe("buildScriptRegister", () => {
  const register = buildScriptRegister({
    docs: [
      doc("SCRIPT-fine"),
      doc("SCRIPT-stale", { inputs: [{ dataset: "SCDB-echo", changed: "2026-07-01" }] }),
      doc("SCRIPT-new", { last_run: undefined }),
      doc("SCRIPT-defn", { variables: ["[[VAR-LVEF]]"] }),
    ],
    runs: [run("SCRIPT-fine"), run("SCRIPT-orphan")],
    variables: [lvef],
  });

  it("groups worst-first, with the current ones last", () => {
    expect(register.groups.map((group) => group.verdict)).toEqual([
      "definition-moved",
      "inputs-moved",
      "never-run",
      "current",
    ]);
  });

  it("counts what the board leads with", () => {
    expect(register.summary).toMatchObject({
      total: 4,
      needsAttention: 3,
      neverRun: 1,
      inputsMoved: 1,
      definitionsMoved: 1,
      codeMoved: 0,
      orphanRuns: 1,
      runs: 2,
    });
  });

  it("reports a run pointing at no documented script rather than dropping it", () => {
    // A typo, or a script somebody runs and never documented. Both are worth
    // someone's attention; neither should vanish.
    expect(register.orphanRuns.map((entry) => entry.id)).toEqual(["RUN-SCRIPT-orphan"]);
  });

  it("shows a run record's own problems on the script it belongs to", () => {
    const withGap = buildScriptRegister({
      docs: [doc("SCRIPT-fine")],
      runs: [run("SCRIPT-fine", { script_hash: undefined })],
      variables: [],
    });
    expect(withGap.rows[0]?.problems.join(" ")).toContain(
      "RUN-SCRIPT-fine: No `script_hash`",
    );
  });

  it("counts docs with no hash, because then nothing can ever say what ran", () => {
    const unhashed = buildScriptRegister({
      docs: [doc("SCRIPT-a", { file_hash: undefined }), doc("SCRIPT-b")],
      runs: [],
      variables: [],
    });
    expect(unhashed.summary.unhashed).toBe(1);
  });
});

describe("searchScripts", () => {
  const rows = buildScriptRegister({
    docs: [
      doc("SCRIPT-echo", { inputs: [{ dataset: "SCDB-echo", version: "2026-Q2" }] }),
      doc("SCRIPT-labs", { purpose: "Cleans the laboratory extract.", variables: ["[[VAR-LVEF]]"] }),
    ],
    runs: [],
    variables: [],
  }).rows;

  it("matches the dataset a script reads", () => {
    expect(searchScripts(rows, "scdb-echo").map((row) => row.doc.id)).toEqual(["SCRIPT-echo"]);
  });

  it("matches the purpose and the variables consumed", () => {
    expect(searchScripts(rows, "laboratory").map((row) => row.doc.id)).toEqual(["SCRIPT-labs"]);
    expect(searchScripts(rows, "var-lvef").map((row) => row.doc.id)).toEqual(["SCRIPT-labs"]);
  });

  it("returns everything for an empty query", () => {
    expect(searchScripts(rows, "  ")).toHaveLength(2);
  });
});
