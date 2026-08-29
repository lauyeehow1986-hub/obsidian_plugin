import { describe, expect, it } from "vitest";
import { parseVariable } from "../catalogue/variable";
import { parseRunRecord } from "./runRecord";
import { parseScriptDoc } from "./scriptDoc";
import { assessScript } from "./staleness";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);

function doc(over: Record<string, unknown> = {}) {
  return parseScriptDoc("50 Scripts/SCRIPT-cohort.md", {
    type: "script-doc",
    id: "SCRIPT-cohort",
    title: "Readmission cohort build",
    purpose: "Builds the analysis cohort.",
    language: "r",
    file: "50 Scripts/cohort-build.R",
    file_hash: HASH_A,
    inputs: [{ dataset: "SCDB-echo", version: "2026-Q1", changed: "2026-01-05" }],
    variables: ["[[VAR-LVEF]]"],
    last_run: "2026-05-12",
    ...over,
  });
}

function run(over: Record<string, unknown> = {}) {
  return parseRunRecord("94 Runs/RUN-2026-05-12-0001.md", {
    type: "run",
    id: "RUN-2026-05-12-0001",
    script: "[[SCRIPT-cohort]]",
    started: "2026-05-12T09:00",
    exit: "ok",
    script_hash: HASH_A,
    ...over,
  });
}

function lvef(over: Record<string, unknown> = {}) {
  return parseVariable("87 Catalogue/VAR-LVEF.md", {
    type: "variable",
    id: "VAR-LVEF",
    label: "Ejection fraction",
    data_type: "numeric",
    definition: "Biplane Simpson's.",
    version: 2,
    changed: "2024-01-01",
    change_reason: "r",
    ...over,
  });
}

const assess = (over: Parameters<typeof assessScript>[0]) => assessScript(over);

describe("assessScript — nothing moved", () => {
  it("is current when every dependency predates the last run", () => {
    const result = assess({ doc: doc(), runs: [run()], variables: [lvef()] });
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("current");
  });

  it("takes the later of the note's last_run and the newest run record", () => {
    // Both are legitimate sources: a run on a machine with no vault gets typed
    // onto the note, and F1 will not always have updated it.
    const fromRun = assess({
      doc: doc({ last_run: "2026-01-01" }),
      runs: [run({ started: "2026-05-12T09:00" })],
      variables: [],
    });
    expect(fromRun.lastRunSource).toBe("run");
    expect(fromRun.lastRunAt).toBe(Date.parse("2026-05-12T09:00"));

    const fromNote = assess({
      doc: doc({ last_run: "2026-05-12" }),
      runs: [run({ started: "2026-01-01T09:00" })],
      variables: [],
    });
    expect(fromNote.lastRunSource).toBe("note");
  });
});

describe("assessScript — silence is not freshness", () => {
  it("flags a script nothing records ever running", () => {
    const result = assess({ doc: doc({ last_run: undefined }), runs: [], variables: [] });
    expect(result.verdict).toBe("never-run");
    expect(result.lastRunSource).toBe("none");
  });

  it("distinguishes an undated run from no run at all", () => {
    const result = assess({
      doc: doc({ last_run: undefined }),
      runs: [run({ started: undefined })],
      variables: [],
    });
    expect(result.verdict).toBe("undated");
    expect(result.findings[0]?.detail).toContain("none carries a readable");
  });

  it("compares nothing when there is no date, rather than reporting everything as fresh", () => {
    // The input moved in 2027; without a run date that is not a finding, it is
    // an unanswerable question, and saying "current" would be the lie.
    const result = assess({
      doc: doc({ last_run: undefined, inputs: [{ dataset: "SCDB-echo", changed: "2027-01-01" }] }),
      runs: [],
      variables: [],
    });
    expect(result.findings.map((finding) => finding.kind)).toEqual(["never-run"]);
  });
});

describe("assessScript — §7 C3's headline: not re-run since the input changed", () => {
  it("flags an input dated after the last run", () => {
    const result = assess({
      doc: doc({ inputs: [{ dataset: "SCDB-echo", version: "2026-Q3", changed: "2026-07-01" }] }),
      runs: [run()],
      variables: [],
    });
    expect(result.verdict).toBe("inputs-moved");
    expect(result.findings[0]?.detail).toBe(
      "SCDB-echo (2026-Q3) changed on 2026-07-01, after this last ran on 2026-05-12.",
    );
  });

  it("does not flag an input that changed before the last run", () => {
    expect(assess({ doc: doc(), runs: [run()], variables: [] }).findings).toEqual([]);
  });

  it("flags each moved dataset separately, so a chase-up names all of them", () => {
    const result = assess({
      doc: doc({
        inputs: [
          { dataset: "SCDB-echo", changed: "2026-07-01" },
          { dataset: "SCDB-admissions", changed: "2026-08-01" },
          { dataset: "SCDB-labs", changed: "2026-01-01" },
        ],
      }),
      runs: [run()],
      variables: [],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.detail.split(" ")[0])).toEqual([
      "SCDB-echo",
      "SCDB-admissions",
    ]);
  });

  it("ignores an input with no date, because there is nothing to compare", () => {
    const result = assess({
      doc: doc({ inputs: [{ dataset: "SCDB-echo", version: "2026-Q3" }] }),
      runs: [run()],
      variables: [],
    });
    expect(result.findings).toEqual([]);
  });
});

describe("assessScript — the C2 join", () => {
  it("flags a consumed definition revised after the script last ran", () => {
    const result = assess({
      doc: doc(),
      runs: [run()],
      variables: [lvef({ version: 3, changed: "2026-06-01" })],
    });
    expect(result.verdict).toBe("definition-moved");
    expect(result.findings[0]?.detail).toContain("VAR-LVEF moved to version 3 on 2026-06-01");
    expect(result.findings[0]?.detail).toContain("under the earlier definition");
  });

  it("asks the time question, not the version question", () => {
    // Citing @1 while the catalogue is at 2 is C2's `stale` finding and is
    // already on the catalogue board. Here the definition came into force
    // before the run, so nothing this script produced is out of date.
    const result = assess({
      doc: doc({ variables: ["[[VAR-LVEF@1]]"] }),
      runs: [run()],
      variables: [lvef()],
    });
    expect(result.findings).toEqual([]);
    expect(result.consumed[0]).toMatchObject({ citedVersion: 1, revisedAfterRun: false });
  });

  it("resolves a ref the catalogue does not hold to null rather than dropping it", () => {
    const result = assess({
      doc: doc({ variables: ["[[VAR-NOWHERE]]"] }),
      runs: [run()],
      variables: [lvef()],
    });
    expect(result.consumed[0]).toMatchObject({ ref: "[[VAR-NOWHERE]]", variable: null });
    expect(result.findings).toEqual([]);
  });
});

describe("assessScript — what ran versus what is documented", () => {
  it("flags a run whose hash differs from the documented one", () => {
    const result = assess({ doc: doc(), runs: [run({ script_hash: HASH_B })], variables: [] });
    expect(result.verdict).toBe("code-moved");
    expect(result.findings[0]?.detail).toContain("bbbbbbbbbbbb");
    expect(result.findings[0]?.detail).toContain("aaaaaaaaaaaa");
  });

  it("does not treat a missing hash as a match", () => {
    // A run that recorded no hash cannot say the code is unchanged. It gets no
    // `code-moved` finding, but the run's own problems report the gap.
    const withoutHash = run({ script_hash: undefined });
    const result = assess({ doc: doc(), runs: [withoutHash], variables: [] });
    expect(result.findings).toEqual([]);
    expect(withoutHash.problems.join(" ")).toContain("which version of the code");
  });

  it("says nothing when the note documents no hash either", () => {
    const result = assess({
      doc: doc({ file_hash: undefined }),
      runs: [run({ script_hash: HASH_B })],
      variables: [],
    });
    expect(result.findings).toEqual([]);
  });
});

describe("assessScript — a failed run", () => {
  it("outranks everything else, because the outputs may not exist", () => {
    const result = assess({
      doc: doc({ inputs: [{ dataset: "SCDB-echo", changed: "2026-07-01" }] }),
      runs: [run({ exit: "error" })],
      variables: [lvef({ version: 3, changed: "2026-06-01" })],
    });
    expect(result.verdict).toBe("run-failed");
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "run-failed",
      "definition-moved",
      "inputs-moved",
    ]);
  });

  it("judges the most recent run, not any run", () => {
    const result = assess({
      doc: doc(),
      runs: [
        parseRunRecord("94 Runs/a.md", {
          type: "run",
          id: "RUN-old",
          script: "[[SCRIPT-cohort]]",
          started: "2026-01-01T09:00",
          exit: "error",
          script_hash: HASH_A,
        }),
        run(),
      ],
      variables: [],
    });
    expect(result.verdict).toBe("current");
    expect(result.runs[0]?.id).toBe("RUN-2026-05-12-0001");
  });
});
