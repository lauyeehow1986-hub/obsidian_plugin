import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { median, requestMetrics, stageDwellStats, worstSlaState } from "./dwell";
import { parseRequest } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";

const spec = testSpec();

function metricsFor(overrides: Record<string, unknown> = {}, now = NOW) {
  const { request } = parseRequest(requestFrontmatter(overrides));
  return { request, metrics: requestMetrics(request, spec, { now }) };
}

/** History built as day offsets from `now`, so assertions do not drift with the clock. */
function historyDaysAgo(entries: [days: number, stage: string][], now = NOW) {
  return entries.map(([days, to]) => ({
    at: new Date(now - days * DAY_MS).toISOString(),
    to,
    by: "yh",
  }));
}

describe("stage segments", () => {
  it("splits the history into occupancies, leaving the current one open", () => {
    const { metrics } = metricsFor();
    expect(metrics.segments.map((s) => s.stageId)).toEqual([
      "intake",
      "triage",
      "awaiting-approval",
    ]);
    expect(metrics.segments[0]!.ms).toBe(2 * DAY_MS);
    expect(metrics.segments[1]!.ms).toBe(2 * DAY_MS);
    expect(metrics.segments[0]!.open).toBe(false);
    expect(metrics.segments[2]!.open).toBe(true);
    expect(metrics.segments[2]!.leftAt).toBeNull();
  });

  it("stops the clock at a terminal stage", () => {
    // "Delivered 90 days ago" is not 90 days of dwell anyone is accountable for.
    const { metrics } = metricsFor({
      stage: "delivered",
      outputs: [{ kind: "table" }],
      history: historyDaysAgo([
        [30, "intake"],
        [20, "extraction"],
        [10, "delivered"],
      ]),
    });
    const last = metrics.segments[metrics.segments.length - 1]!;
    expect(last.stageId).toBe("delivered");
    expect(last.open).toBe(false);
    expect(last.ms).toBe(0);
    expect(metrics.completed).toBe(true);
  });

  it("returns nothing, and says so, when there is no history", () => {
    const { metrics } = metricsFor({ history: [] });
    expect(metrics.segments).toEqual([]);
    expect(metrics.currentDwellMs).toBeNull();
    expect(metrics.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("No history entries")]),
    );
  });
});

describe("dwell, age and turnaround", () => {
  it("measures current dwell from the last history entry", () => {
    const { metrics } = metricsFor();
    expect(metrics.currentDwellMs).toBe(NOW - Date.UTC(2026, 6, 18));
  });

  it("measures age from `received`, not from when the note was created", () => {
    // A note written days after the request arrived must not understate the wait.
    const { metrics } = metricsFor({
      received: "2026-07-01",
      history: [{ at: "2026-07-14", to: "awaiting-approval" }],
    });
    expect(metrics.totalAgeMs).toBe(NOW - Date.UTC(2026, 6, 1));
    expect(metrics.currentDwellMs).toBe(NOW - Date.UTC(2026, 6, 14));
  });

  it("freezes age and reports turnaround once complete", () => {
    const history = historyDaysAgo([
      [30, "intake"],
      [10, "delivered"],
    ]);
    const { metrics } = metricsFor({
      stage: "delivered",
      received: history[0]!.at,
      history,
      outputs: [{ kind: "table" }],
    });
    expect(metrics.totalAgeMs).toBe(20 * DAY_MS);
    expect(metrics.turnaroundMs).toBe(20 * DAY_MS);
    // It has still been sitting in `delivered` for ten days; that is dwell, not age.
    expect(metrics.currentDwellMs).toBe(10 * DAY_MS);
  });

  it("has no turnaround while still in flight", () => {
    expect(metricsFor().metrics.turnaroundMs).toBeNull();
  });

  it("survives a note whose dates contradict each other", () => {
    const { metrics } = metricsFor({
      received: "2026-07-20",
      history: [{ at: "2026-07-14", to: "awaiting-approval" }],
    });
    expect(metrics.totalAgeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("predates `received`")]),
    );
  });

  it("rolls time up per stage, longest first", () => {
    const { metrics } = metricsFor({
      stage: "extraction",
      history: historyDaysAgo([
        [40, "intake"],
        [38, "triage"],
        [30, "extraction"],
        [20, "qc"],
        [15, "extraction"],
      ]),
    });
    expect(metrics.perStageMs[0]).toEqual({ stageId: "extraction", ms: 25 * DAY_MS, visits: 2 });
    expect(metrics.perStageMs.find((s) => s.stageId === "qc")).toEqual({
      stageId: "qc",
      ms: 5 * DAY_MS,
      visits: 1,
    });
  });
});

describe("bounces and revisits", () => {
  it("counts nothing for a request that only moves forward", () => {
    const { metrics } = metricsFor();
    expect(metrics.bounceCount).toBe(0);
    expect(metrics.revisitCount).toBe(0);
  });

  it("counts a send-back as a bounce and the return as a revisit", () => {
    // The rework signal: this request looks fresh on current dwell alone.
    const history = historyDaysAgo([
      [40, "intake"],
      [30, "extraction"],
      [20, "qc"],
      [15, "extraction"],
      [1, "qc"],
    ]);
    const { metrics } = metricsFor({ stage: "qc", received: history[0]!.at, history });
    expect(metrics.bounceCount).toBe(1);
    expect(metrics.revisitCount).toBe(2);
    // Fresh on current dwell, forty days old, bounced once — all three at once.
    expect(metrics.currentDwellMs).toBe(1 * DAY_MS);
    expect(metrics.totalAgeMs).toBe(40 * DAY_MS);
  });

  it("does not count a sideways move to on-hold as a bounce", () => {
    // `on-hold` sits after `delivered` in declaration order, so it is not "back".
    const { metrics } = metricsFor({
      stage: "on-hold",
      history: historyDaysAgo([
        [20, "triage"],
        [10, "on-hold"],
      ]),
    });
    expect(metrics.bounceCount).toBe(0);
  });
});

describe("SLA state", () => {
  function stateAfter(days: number, stage = "awaiting-approval") {
    return metricsFor({
      stage,
      due: "2099-01-01",
      history: historyDaysAgo([[days, stage]]),
    }).metrics.stageSla;
  }

  it("is on track well inside the target", () => {
    expect(stateAfter(3).state).toBe("on-track");
  });

  it("turns at-risk at 80% of the stage target", () => {
    // awaiting-approval targets 14 days, so 11.2 days is the threshold.
    expect(stateAfter(11).state).toBe("on-track");
    expect(stateAfter(12).state).toBe("at-risk");
  });

  it("breaches past the target and reports by how much", () => {
    const sla = stateAfter(20);
    expect(sla.state).toBe("breached");
    expect(sla.targetDays).toBe(14);
    expect(sla.overByMs).toBe(6 * DAY_MS);
  });

  it("has no target for a stage the spec gives none", () => {
    expect(stateAfter(90, "on-hold").state).toBe("no-target");
  });

  it("stops assessing a completed request", () => {
    const { metrics } = metricsFor({
      stage: "delivered",
      due: "2020-01-01",
      history: historyDaysAgo([[400, "delivered"]]),
    });
    expect(metrics.stageSla.state).toBe("no-target");
    expect(metrics.dueSla.state).toBe("no-target");
  });

  it("assesses the note's own due date separately", () => {
    expect(metricsFor({ due: "2026-08-04" }).metrics.dueSla.state).toBe("on-track");
    expect(metricsFor({ due: "2026-07-30" }).metrics.dueSla.state).toBe("at-risk");
    const breached = metricsFor({ due: "2026-07-20" }).metrics.dueSla;
    expect(breached.state).toBe("breached");
    expect(breached.overByMs).toBeGreaterThan(0);
  });

  it("ranks states so a row can carry one badge", () => {
    expect(worstSlaState("on-track", "breached", "at-risk")).toBe("breached");
    expect(worstSlaState("no-target", "on-track")).toBe("on-track");
    expect(worstSlaState()).toBe("no-target");
  });
});

describe("holdup", () => {
  it("measures the holdup from `blocked_since`", () => {
    const { metrics } = metricsFor();
    expect(metrics.blockedOn).toBe("[[Dr A Tan]]");
    expect(metrics.blockedForMs).toBe(NOW - Date.UTC(2026, 6, 18));
  });

  it("falls back to the stage entry when `blocked_since` is missing", () => {
    const frontmatter = requestFrontmatter();
    delete frontmatter["blocked_since"];
    const { request } = parseRequest(frontmatter);
    const metrics = requestMetrics(request, spec, { now: NOW });
    expect(metrics.blockedForMs).toBe(NOW - Date.UTC(2026, 6, 18));
  });

  it("reports no holdup when nobody is blocking", () => {
    const frontmatter = requestFrontmatter({
      history: [{ at: "2026-07-18", to: "awaiting-approval", by: "yh" }],
    });
    delete frontmatter["blocked_on"];
    const { request } = parseRequest(frontmatter);
    const metrics = requestMetrics(request, spec, { now: NOW });
    expect(metrics.blockedOn).toBeNull();
    expect(metrics.blockedForMs).toBeNull();
  });
});

describe("unknown stages", () => {
  it("flags a stage the spec no longer has", () => {
    const { metrics } = metricsFor({
      stage: "pre-triage",
      history: [{ at: "2026-07-14", to: "pre-triage" }],
    });
    expect(metrics.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("not in workflow")]),
    );
  });

  it("resolves a retired stage through the spec's mapping", () => {
    const migrated = testSpec({ retired: { "pre-triage": "triage" } });
    const { request } = parseRequest(
      requestFrontmatter({ stage: "pre-triage", history: [{ at: "2026-07-14", to: "pre-triage" }] }),
    );
    const metrics = requestMetrics(request, migrated, { now: NOW });
    expect(metrics.problems).toEqual([]);
    expect(metrics.stageSla.targetDays).toBe(3);
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
});

describe("stageDwellStats", () => {
  it("separates closed occupancies from ones still running", () => {
    // Mixing them drags the median down: a request that entered this morning
    // says nothing about how long the stage usually takes.
    const requests = [
      metricsFor({
        stage: "delivered",
        outputs: [{ kind: "t" }],
        history: historyDaysAgo([
          [30, "triage"],
          [20, "awaiting-approval"],
          [5, "delivered"],
        ]),
      }),
      metricsFor({
        stage: "delivered",
        outputs: [{ kind: "t" }],
        history: historyDaysAgo([
          [40, "triage"],
          [20, "awaiting-approval"],
          [2, "delivered"],
        ]),
      }),
      metricsFor({
        stage: "awaiting-approval",
        history: historyDaysAgo([
          [8, "triage"],
          [1, "awaiting-approval"],
        ]),
      }),
    ];

    const stats = stageDwellStats(requests, spec);
    const approval = stats.find((s) => s.stageId === "awaiting-approval")!;
    expect(approval.closedCount).toBe(2);
    expect(approval.medianClosedMs).toBe(16.5 * DAY_MS);
    expect(approval.openCount).toBe(1);
    expect(approval.longestOpenMs).toBe(1 * DAY_MS);

    // Triage occupancies: 10, 20 and 7 days — all three closed.
    const triage = stats.find((s) => s.stageId === "triage")!;
    expect(triage.closedCount).toBe(3);
    expect(triage.medianClosedMs).toBe(10 * DAY_MS);
  });

  it("lists every stage in the spec, including the empty ones", () => {
    const stats = stageDwellStats([], spec);
    expect(stats.map((s) => s.stageId)).toEqual(spec.stages.map((s) => s.id));
    expect(stats.every((s) => s.medianClosedMs === null && s.openCount === 0)).toBe(true);
  });
});
