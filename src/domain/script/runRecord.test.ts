import { describe, expect, it } from "vitest";
import { parseRunRecord, runMatchesScript, runsForScript } from "./runRecord";
import { parseScriptDoc } from "./scriptDoc";

const HASH = "cc".repeat(32);

function run(over: Record<string, unknown> = {}) {
  return parseRunRecord("94 Runs/RUN-2026-07-24-0007.md", {
    type: "run",
    id: "RUN-2026-07-24-0007",
    script: "[[SCRIPT-readmission-cohort]]",
    request: "[[REQ-2026-014]]",
    language: "r",
    interpreter: "R 4.4.1 (portable)",
    started: "2026-07-24T11:02",
    duration_s: 38,
    exit: "ok",
    script_hash: `sha256:${HASH}`,
    inputs: [{ dataset: "SCDB-echo", version: "2026-Q2", rows: 4213 }],
    variables: ["[[VAR-LVEF]]"],
    outputs: [{ kind: "table", path: "94 Runs/table1.csv", hash: `sha256:${"dd".repeat(32)}` }],
    ...over,
  });
}

const doc = (over: Record<string, unknown> = {}) =>
  parseScriptDoc("50 Scripts/SCRIPT-readmission-cohort.md", {
    type: "script-doc",
    id: "SCRIPT-readmission-cohort",
    purpose: "p",
    file: "f.R",
    ...over,
  });

describe("parseRunRecord", () => {
  it("reads §5.12's record", () => {
    const parsed = run();
    expect(parsed.problems).toEqual([]);
    expect(parsed.interpreter).toBe("R 4.4.1 (portable)");
    expect(parsed.scriptHash).toBe(HASH);
    expect(parsed.durationS).toBe(38);
    expect(parsed.inputs[0]).toEqual({ dataset: "SCDB-echo", version: "2026-Q2", rows: 4213 });
    expect(parsed.outputs[0]?.kind).toBe("table");
  });

  it("reports a run with no script_hash, because that is the point of the note", () => {
    expect(run({ script_hash: undefined }).problems.join(" ")).toContain(
      "which version of the code produced it",
    );
  });

  it("reports a run that cannot be placed in time", () => {
    expect(run({ started: undefined }).problems.join(" ")).toContain("cannot be placed in time");
  });

  it("reports a run attached to nothing", () => {
    expect(run({ script: undefined }).problems.join(" ")).toContain("not attached to anything");
  });

  it("keeps an unknown exit state out of the field but names it", () => {
    const parsed = run({ exit: "crashed" });
    expect(parsed.exit).toBe("");
    expect(parsed.problems.join(" ")).toContain('Exit state "crashed"');
  });

  it("leaves exit empty rather than assuming ok when the note is silent", () => {
    expect(run({ exit: undefined }).exit).toBe("");
  });
});

describe("runMatchesScript", () => {
  it("matches a wikilink, a bare id and a path alike", () => {
    expect(runMatchesScript(run(), doc())).toBe(true);
    expect(runMatchesScript(run({ script: "SCRIPT-readmission-cohort" }), doc())).toBe(true);
    expect(
      runMatchesScript(run({ script: "[[50 Scripts/SCRIPT-readmission-cohort|the cohort build]]" }), doc()),
    ).toBe(true);
  });

  it("matches on the filename when the note carries no id", () => {
    expect(runMatchesScript(run(), doc({ id: undefined }))).toBe(true);
  });

  it("does not match a different script", () => {
    expect(runMatchesScript(run({ script: "[[SCRIPT-other]]" }), doc())).toBe(false);
    expect(runMatchesScript(run({ script: undefined }), doc())).toBe(false);
  });
});

describe("runsForScript", () => {
  it("returns the script's own runs, newest first", () => {
    const runs = [
      run({ id: "old", started: "2026-01-01T09:00" }),
      run({ id: "new", started: "2026-07-24T11:02" }),
      run({ id: "elsewhere", script: "[[SCRIPT-other]]" }),
    ];
    expect(runsForScript(doc(), runs).map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("puts undated runs last and orders them stably", () => {
    // Two undated runs subtracted from each other give NaN, and a comparator
    // returning NaN leaves the order to chance.
    const runs = [
      parseRunRecord("94 Runs/b.md", { type: "run", id: "b", script: "[[SCRIPT-readmission-cohort]]" }),
      parseRunRecord("94 Runs/a.md", { type: "run", id: "a", script: "[[SCRIPT-readmission-cohort]]" }),
      run({ id: "dated" }),
    ];
    expect(runsForScript(doc(), runs).map((entry) => entry.id)).toEqual(["dated", "a", "b"]);
  });
});
