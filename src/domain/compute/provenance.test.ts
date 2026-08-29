import { describe, expect, it } from "vitest";
import { planRun } from "../script/recordRun";
import { parseScriptDoc } from "../script/scriptDoc";
import { blockLabel, planObservedRun, type ObservedRun } from "./provenance";
import type { RunOutcome } from "./outcome";

const STARTED = Date.parse("2026-08-29T16:40:00");

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    exit: "ok",
    code: 0,
    stdout: "1\n",
    stderr: "",
    durationMs: 432,
    figures: [],
    interpreter: "Python 3.14.7 (C:\\Python314\\python.exe)",
    truncated: false,
    ...overrides,
  };
}

function run(overrides: Partial<ObservedRun> = {}): ObservedRun {
  return {
    source: "[[Invented block workbench]]",
    block: "python #1",
    language: "python",
    script: "print(1)\n",
    scriptHash: "a".repeat(64),
    outcome: outcome(),
    started: STARTED,
    actor: "yh",
    request: "",
    inputs: [],
    variables: [],
    ...overrides,
  };
}

describe("the record an observed run writes", () => {
  it("names the run, the note and the block", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.id).toBe("RUN-2026-08-29-0001");
    expect(plan.frontmatter["type"]).toBe("run");
    expect(plan.frontmatter["script"]).toBe("[[Invented block workbench]]");
    expect(plan.frontmatter["block"]).toBe("python #1");
  });

  // The distinction the whole module exists for. `ran_by` means the plugin
  // watched this happen; `recorded_by` means a person says it did.
  it("says it was observed, not reported", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.frontmatter["ran_by"]).toBe("yh");
    expect(plan.frontmatter["recorded_by"]).toBeUndefined();
  });

  it("records the interpreter, the hash and the duration", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.frontmatter["interpreter"]).toBe("Python 3.14.7 (C:\\Python314\\python.exe)");
    expect(plan.frontmatter["script_hash"]).toBe(`sha256:${"a".repeat(64)}`);
    expect(plan.frontmatter["duration_s"]).toBe(0.4);
  });

  it("normalises a hash written with its prefix", () => {
    const plan = planObservedRun({ run: run({ scriptHash: `SHA256:${"B".repeat(64)}` }), sequence: 1 });
    expect(plan.frontmatter["script_hash"]).toBe(`sha256:${"b".repeat(64)}`);
  });

  it("lists the figures as outputs", () => {
    const plan = planObservedRun({
      run: run({ outcome: outcome({ figures: ["94 Runs/RUN-2026-08-29-0001-fig1.png"] }) }),
      sequence: 1,
    });
    expect(plan.frontmatter["outputs"]).toEqual([
      { kind: "plot", path: "94 Runs/RUN-2026-08-29-0001-fig1.png" },
    ]);
  });

  it("omits the optional fields rather than writing empty ones", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.frontmatter["request"]).toBeUndefined();
    expect(plan.frontmatter["inputs"]).toBeUndefined();
    expect(plan.frontmatter["outputs"]).toBeUndefined();
    expect(plan.frontmatter["variables"]).toBeUndefined();
  });

  it("carries the request and the dataset when they were given", () => {
    const plan = planObservedRun({
      run: run({ request: "[[REQ-2026-014]]", inputs: [{ dataset: "SCDB-echo", version: "2026-Q2" }] }),
      sequence: 1,
    });
    expect(plan.frontmatter["request"]).toBe("[[REQ-2026-014]]");
    expect(plan.frontmatter["inputs"]).toEqual([{ dataset: "SCDB-echo", version: "2026-Q2" }]);
  });

  it("continues the day's sequence", () => {
    expect(planObservedRun({ run: run(), sequence: 7 }).id).toBe("RUN-2026-08-29-0007");
  });
});

describe("what the record admits it cannot answer", () => {
  it("says so when no data version was recorded", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.weaknesses.join(" ")).toContain("cannot be tied to a particular extract");
  });

  it("says so when a dataset was named without a version", () => {
    const plan = planObservedRun({
      run: run({ inputs: [{ dataset: "SCDB-echo", version: "" }] }),
      sequence: 1,
    });
    expect(plan.weaknesses.join(" ")).toContain("no version");
  });

  it("says so when the interpreter did not identify itself", () => {
    const plan = planObservedRun({ run: run({ outcome: outcome({ interpreter: "" }) }), sequence: 1 });
    expect(plan.weaknesses.join(" ")).toContain("what the code ran under");
  });

  it("says so when the output was cut", () => {
    const plan = planObservedRun({ run: run({ outcome: outcome({ truncated: true }) }), sequence: 1 });
    expect(plan.weaknesses.join(" ")).toContain("not the whole");
  });

  it("has nothing to complain about when everything was recorded", () => {
    const plan = planObservedRun({
      run: run({ inputs: [{ dataset: "SCDB-echo", version: "2026-Q2" }] }),
      sequence: 1,
    });
    expect(plan.weaknesses).toEqual([]);
  });
});

describe("the record's body", () => {
  it("keeps the code that ran, verbatim", () => {
    const plan = planObservedRun({ run: run({ script: "print('exact')\n" }), sequence: 1 });
    expect(plan.body).toContain("print('exact')");
  });

  // So the archive of a past run is not itself offered as something to run.
  it("fences the archived code no-run", () => {
    const plan = planObservedRun({ run: run(), sequence: 1 });
    expect(plan.body).toContain("```python no-run");
  });

  it("grows the fence when the code contains one", () => {
    const plan = planObservedRun({ run: run({ script: 'x = """```"""\n' }), sequence: 1 });
    expect(plan.body).toContain("````python no-run");
  });
});

describe("the ledger line", () => {
  // Rule 7: ids and counts, never content.
  it("carries no output and no code", () => {
    const plan = planObservedRun({
      run: run({ script: "print('patient 12345')\n", outcome: outcome({ stdout: "patient 12345" }) }),
      sequence: 1,
    });
    expect(plan.auditDetail).not.toContain("patient");
    expect(plan.auditDetail).toContain("RUN-2026-08-29-0001");
    expect(plan.auditDetail).toContain("exit ok");
  });

  it("says when there was no hash to record", () => {
    const plan = planObservedRun({ run: run({ scriptHash: "not a hash" }), sequence: 1 });
    expect(plan.auditDetail).toContain("no script hash");
  });
});

/**
 * The two run-record writers have to stay recognisably the same document.
 *
 * `recordRun` writes the hearsay kind and this module writes the observed kind.
 * They differ on purpose — that difference is what tells an auditor which they
 * are holding — but a field that means the same thing in both must be spelled
 * the same in both, or `94 Runs/` stops being one queryable folder.
 */
describe("the two kinds of run record agree on their shared fields", () => {
  const doc = parseScriptDoc("50 Scripts/SCRIPT-x.md", {
    type: "script-doc",
    id: "SCRIPT-x",
    language: "python",
  });

  const recorded = planRun({
    doc,
    draft: {
      started: STARTED,
      durationS: 0.4,
      exit: "ok",
      interpreter: "Python 3.14.7",
      scriptHash: "a".repeat(64),
      inputs: [],
      outputs: [],
      request: "",
    },
    actor: "yh",
    sequence: 1,
  });
  const observed = planObservedRun({ run: run(), sequence: 1 });

  it("allocates ids the same way", () => {
    expect(observed.id).toBe(recorded.id);
  });

  it("agrees on the fields that mean the same thing", () => {
    for (const key of ["type", "id", "started", "exit", "duration_s", "script_hash", "language"]) {
      expect(observed.frontmatter[key], key).toEqual(recorded.frontmatter[key]);
    }
  });

  it("differs only where the difference is the point", () => {
    expect(recorded.frontmatter["recorded_by"]).toBe("yh");
    expect(recorded.frontmatter["ran_by"]).toBeUndefined();
    expect(observed.frontmatter["ran_by"]).toBe("yh");
    expect(observed.frontmatter["recorded_by"]).toBeUndefined();
  });
});

describe("naming a block on the record", () => {
  it("reads as a position, because that is what it is", () => {
    expect(blockLabel("r", 2)).toBe("r #2");
  });
});
