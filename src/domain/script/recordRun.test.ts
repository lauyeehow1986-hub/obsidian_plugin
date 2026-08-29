import { describe, expect, it } from "vitest";
import { planRun, runId, type RunDraft } from "./recordRun";
import { parseScriptDoc } from "./scriptDoc";

const HASH = "ee".repeat(32);
const STARTED = Date.parse("2026-07-24T11:02:00");

function doc(over: Record<string, unknown> = {}) {
  return parseScriptDoc("50 Scripts/SCRIPT-cohort.md", {
    type: "script-doc",
    id: "SCRIPT-cohort",
    purpose: "Builds the cohort.",
    language: "r",
    file: "50 Scripts/cohort.R",
    file_hash: HASH,
    variables: ["[[VAR-LVEF@2]]"],
    ...over,
  });
}

function draft(over: Partial<RunDraft> = {}): RunDraft {
  return {
    started: STARTED,
    durationS: 38,
    exit: "ok",
    interpreter: "R 4.4.1 (portable)",
    scriptHash: "",
    inputs: [{ dataset: "SCDB-echo", version: "2026-Q2", rows: 4213 }],
    outputs: [{ kind: "table", path: "94 Runs/table1.csv" }],
    request: "[[REQ-2026-014]]",
    ...over,
  };
}

const plan = (over: { doc?: ReturnType<typeof doc>; draft?: RunDraft; sequence?: number } = {}) =>
  planRun({
    doc: over.doc ?? doc(),
    draft: over.draft ?? draft(),
    actor: "yh",
    sequence: over.sequence ?? 7,
  });

describe("runId", () => {
  it("follows §5.12's shape", () => {
    expect(runId(STARTED, 7)).toBe("RUN-2026-07-24-0007");
  });
});

describe("planRun", () => {
  it("writes a §5.12 record", () => {
    const result = plan();
    expect(result.refusals).toEqual([]);
    expect(result.frontmatter).toMatchObject({
      type: "run",
      id: "RUN-2026-07-24-0007",
      script: "[[SCRIPT-cohort]]",
      started: "2026-07-24T11:02",
      exit: "ok",
      language: "r",
      interpreter: "R 4.4.1 (portable)",
      duration_s: 38,
      script_hash: `sha256:${HASH}`,
      request: "[[REQ-2026-014]]",
    });
    expect(result.frontmatter["inputs"]).toEqual([
      { dataset: "SCDB-echo", version: "2026-Q2", rows: 4213 },
    ]);
    expect(result.frontmatter["outputs"]).toEqual([{ path: "94 Runs/table1.csv", kind: "table" }]);
  });

  it("records who typed it, not who was watched running it", () => {
    // The plugin did not run anything. Same distinction as §5.11's
    // `composed_only`, and the reason the ledger action is `run-recorded`.
    expect(plan().frontmatter).toMatchObject({ recorded_by: "yh" });
  });

  it("copies the doc's variables onto the run, so the catalogue counts it", () => {
    expect(plan().frontmatter["variables"]).toEqual(["[[VAR-LVEF@2]]"]);
  });

  it("falls back to the documented hash when the dialog gives none", () => {
    expect(plan({ draft: draft({ scriptHash: "" }) }).frontmatter["script_hash"]).toBe(`sha256:${HASH}`);
  });

  it("prefers a hash typed for this run over the documented one", () => {
    const other = "ff".repeat(32);
    expect(plan({ draft: draft({ scriptHash: other }) }).frontmatter["script_hash"]).toBe(
      `sha256:${other}`,
    );
  });

  it("advances only the fields a run establishes", () => {
    // What one run happened to read is not a change to what the script is
    // documented to consume, so `inputs` on the doc is left alone.
    expect(plan().patch).toEqual({ last_run: "2026-07-24", last_run_by: "yh" });
  });

  it("refuses a run it cannot place in time", () => {
    expect(plan({ draft: draft({ started: null }) }).refusals.join(" ")).toContain(
      "needs a date and time it started",
    );
  });

  it("refuses when the script note has no id to point at", () => {
    expect(plan({ doc: doc({ id: undefined }) }).refusals.join(" ")).toContain("nothing to point at");
  });

  it("records a weak run rather than refusing it", () => {
    // Refusing over a forgotten interpreter version would mean no record at
    // all, which is strictly worse than a record that says what it cannot say.
    const result = plan({
      doc: doc({ file_hash: undefined }),
      draft: draft({ interpreter: "  ", scriptHash: "", outputs: [], inputs: [] }),
    });
    expect(result.refusals).toEqual([]);
    expect(result.weaknesses).toHaveLength(4);
    expect(result.weaknesses.join(" ")).toContain("which version of the code");
    expect(result.frontmatter["script_hash"]).toBeUndefined();
  });

  it("carries ids and counts into the ledger detail, never content (rule 7)", () => {
    expect(plan().auditDetail).toBe("RUN-2026-07-24-0007; exit ok; 1 input, 1 output");
    expect(plan({ doc: doc({ file_hash: undefined }), draft: draft({ scriptHash: "" }) }).auditDetail).toContain(
      "no script hash",
    );
  });

  it("drops an input or output line left blank in the dialog", () => {
    const result = plan({
      draft: draft({
        inputs: [{ dataset: "  ", version: "x", rows: null }],
        outputs: [{ kind: "plot", path: "  " }],
      }),
    });
    expect(result.frontmatter["inputs"]).toBeUndefined();
    expect(result.frontmatter["outputs"]).toBeUndefined();
  });
});
