import { describe, expect, it } from "vitest";
import {
  capOutput,
  classifyExit,
  formatDuration,
  outcomeDetail,
  outcomeSummary,
  type RunOutcome,
} from "./outcome";

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    exit: "ok",
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 400,
    figures: [],
    interpreter: "Python 3.14.7",
    truncated: false,
    ...overrides,
  };
}

describe("how a process ending is read", () => {
  it("calls a clean exit ok", () => {
    expect(classifyExit({ code: 0, timedOut: false, stopped: false, spawnFailed: false })).toBe("ok");
  });

  it("calls a non-zero exit an error", () => {
    expect(classifyExit({ code: 1, timedOut: false, stopped: false, spawnFailed: false })).toBe("error");
  });

  // Two different facts. One is a person deciding they had seen enough; the
  // other is the machine deciding for them, and a record that conflated them
  // would lose the difference.
  it("keeps a timeout and a person pressing Stop apart", () => {
    expect(classifyExit({ code: null, timedOut: true, stopped: false, spawnFailed: false })).toBe("timeout");
    expect(classifyExit({ code: null, timedOut: false, stopped: true, spawnFailed: false })).toBe("killed");
  });

  it("counts a timeout as a timeout even though it was killed to achieve it", () => {
    expect(classifyExit({ code: null, timedOut: true, stopped: true, spawnFailed: false })).toBe("timeout");
  });
});

describe("capping output", () => {
  it("leaves output inside the budget alone", () => {
    const result = capOutput("short", 100);
    expect(result).toEqual({ text: "short", cut: false });
  });

  // A cap that dropped the end would throw away the traceback, which is the
  // part worth keeping.
  it("keeps both ends and says how much went", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const result = capOutput(lines, 400);
    expect(result.cut).toBe(true);
    expect(result.text).toContain("line 0");
    expect(result.text).toContain("line 399");
    expect(result.text).toContain("characters omitted");
    expect(result.text.length).toBeLessThan(lines.length);
  });

  it("does not cut mid-line", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const result = capOutput(lines, 300);
    const head = result.text.split("\n\n…")[0] ?? "";
    expect(head.endsWith("\n")).toBe(false);
    expect(head.split("\n").every((line) => /^line \d+$/.test(line))).toBe(true);
  });

  it("treats a zero budget as no cap rather than as no output", () => {
    expect(capOutput("anything", 0).text).toBe("anything");
  });
});

describe("durations at run scale", () => {
  it("uses milliseconds under a second", () => {
    expect(formatDuration(400)).toBe("400 ms");
  });

  it("uses one decimal for short runs and none for longer ones", () => {
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(42_000)).toBe("42 s");
  });

  it("breaks into minutes past sixty seconds", () => {
    expect(formatDuration(72_000)).toBe("1 m 12 s");
  });
});

describe("the banner and the ledger line", () => {
  it("puts everything an eye needs on one line", () => {
    const summary = outcomeSummary({
      runId: "RUN-2026-08-29-0001",
      outcome: outcome({ figures: ["94 Runs/RUN-2026-08-29-0001-fig1.png"] }),
      at: "2026-08-29T16:40",
    });
    expect(summary).toBe("2026-08-29T16:40 · RUN-2026-08-29-0001 · Python 3.14.7 · 400 ms · ok · 1 figure");
  });

  it("says the interpreter is unknown rather than leaving a gap", () => {
    expect(outcomeSummary({ runId: "R1", outcome: outcome({ interpreter: "" }), at: "t" })).toContain(
      "unknown interpreter",
    );
  });

  // Rule 7: the ledger carries ids and counts, never a line of the output.
  it("keeps output out of the ledger detail", () => {
    const detail = outcomeDetail(
      "RUN-2026-08-29-0001",
      outcome({ stdout: "patient 12345 readmitted", exit: "error", truncated: true }),
    );
    expect(detail).not.toContain("patient");
    expect(detail).toContain("exit error");
    expect(detail).toContain("output truncated");
  });
});
