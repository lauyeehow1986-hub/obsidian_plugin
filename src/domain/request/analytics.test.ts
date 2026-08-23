import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import {
  dwellDistribution,
  governanceRisk,
  medianDwellByStage,
  queueByStage,
  topBlockingParties,
  turnaroundTrend,
  workloadByHat,
  type ChartSeries,
} from "./analytics";
import { requestMetrics } from "./dwell";
import type { RequestView } from "./holdup";
import { parseRequest } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";

const spec = testSpec();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function view(overrides: Record<string, unknown>): RequestView {
  const built = requestFrontmatter(overrides);
  if (overrides["blocked_on"] === undefined) {
    delete built["blocked_on"];
    delete built["blocked_since"];
  }
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

/** A request that has sat in `stage` for `days`. */
function stuck(id: string, stage: string, days: number, extra: Record<string, unknown> = {}) {
  return view({
    id,
    stage,
    due: "2099-01-01",
    history: [{ at: iso(days), to: stage, by: "yh" }],
    ...extra,
  });
}

function labels(series: ChartSeries): string[] {
  return series.slices.map((slice) => slice.label);
}

function valueFor(series: ChartSeries, label: string): number | undefined {
  return series.slices.find((slice) => slice.label === label)?.value;
}

/* Every series is a chart, and §6 makes two things non-negotiable on a chart. */
describe("every series states its unit and denominator", () => {
  const views = [stuck("REQ-1", "triage", 2), stuck("REQ-2", "extraction", 40)];
  const series = [
    queueByStage(views, spec),
    medianDwellByStage(views, spec),
    dwellDistribution(views),
    topBlockingParties(views),
    workloadByHat(views, [{ id: "hod", label: "Head of SCDB" }]),
    governanceRisk(views, spec, NOW).byGate,
  ];

  it.each(series.map((s) => [s.id, s] as const))("%s", (_id, s) => {
    expect(s.unit.length).toBeGreaterThan(0);
    expect(s.denominator).toMatch(/\d/);
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.empty.length).toBeGreaterThan(0);
  });

  it("covers the trend series too", () => {
    const trend = turnaroundTrend(views, { now: NOW });
    expect(trend.unit).toContain("days");
    expect(trend.denominator).toMatch(/\d/);
  });
});

describe("queueByStage", () => {
  const views = [
    stuck("REQ-1", "triage", 1),
    stuck("REQ-2", "awaiting-approval", 20),
    stuck("REQ-3", "awaiting-approval", 2),
  ];

  it("keeps the spec's pipeline order rather than sorting by size", () => {
    // Sorting by count would hide *where* the pile-up is, which is the only
    // question this chart answers.
    const order = labels(queueByStage(views, spec));
    expect(order.indexOf("SCDB triage")).toBeLessThan(order.indexOf("Awaiting approval"));
    expect(order.indexOf("Awaiting approval")).toBeLessThan(order.indexOf("QC"));
  });

  it("leaves terminal stages out — delivered is not in the queue", () => {
    expect(labels(queueByStage(views, spec))).not.toContain("Delivered");
  });

  it("counts live requests per stage", () => {
    const series = queueByStage(views, spec);
    expect(valueFor(series, "Awaiting approval")).toBe(2);
    expect(valueFor(series, "SCDB triage")).toBe(1);
    expect(series.denominator).toBe("3 live requests");
  });

  it("emphasises the overdue portion and spells it out in words", () => {
    // §6: never colour alone. The shaded part of the bar must also be a label.
    const series = queueByStage([stuck("REQ-9", "triage", 40)], spec);
    const bar = series.slices.find((slice) => slice.label === "SCDB triage");
    expect(bar?.emphasis).toEqual({ value: 1, label: "1 overdue" });
  });

  it("shows a stage the spec has dropped rather than silently omitting it", () => {
    // Labelled "Invented stage", not "invented-stage": the bar is humanised like
    // every other, and the fact that no spec declares it is said outright on the
    // health table rather than implied by leaving a slug on the axis.
    const series = queueByStage([stuck("REQ-X", "invented-stage", 3)], spec);
    expect(valueFor(series, "Invented stage")).toBe(1);
  });
});

describe("medianDwellByStage", () => {
  it("measures completed visits only, so a fresh arrival cannot flatter a stage", () => {
    // REQ-1 passed through triage in 10 days and is now sitting in extraction.
    // A median that counted the open extraction visit would report ~0 for it.
    const passed = view({
      id: "REQ-1",
      stage: "extraction",
      due: "2099-01-01",
      history: [
        { at: iso(30), to: "triage", by: "yh" },
        { at: iso(20), to: "extraction", by: "yh" },
      ],
    });
    const series = medianDwellByStage([passed], spec);
    expect(valueFor(series, "SCDB triage")).toBe(10);
    expect(labels(series)).not.toContain("Extraction");
    expect(series.denominator).toBe("1 completed stage visit");
  });

  it("says so plainly when nothing has left a stage yet", () => {
    const series = medianDwellByStage([stuck("REQ-1", "triage", 2)], spec);
    expect(series.slices).toHaveLength(0);
    expect(series.empty).toContain("completed visit");
  });
});

describe("dwellDistribution", () => {
  it("keeps empty buckets, because a gap in a distribution is information", () => {
    const series = dwellDistribution([stuck("REQ-1", "triage", 1), stuck("REQ-2", "triage", 90)]);
    expect(series.slices).toHaveLength(6);
    expect(valueFor(series, "under 3 days")).toBe(1);
    expect(valueFor(series, "3–7 days")).toBe(0);
    expect(valueFor(series, "over 2 months")).toBe(1);
  });

  it("puts a value on the boundary in the upper bucket", () => {
    // Buckets are [min, max); stating it in a test so a later edit cannot
    // quietly double-count a request that sits exactly on an edge.
    const series = dwellDistribution([stuck("REQ-1", "triage", 7)]);
    expect(valueFor(series, "3–7 days")).toBe(0);
    expect(valueFor(series, "1–2 weeks")).toBe(1);
  });
});

describe("topBlockingParties", () => {
  const blocked = (id: string, party: string, days: number) =>
    stuck(id, "awaiting-approval", days, { blocked_on: party, blocked_since: iso(days) });

  it("ranks by how many requests each party is holding", () => {
    const series = topBlockingParties([
      blocked("REQ-1", "[[Dr A]]", 3),
      blocked("REQ-2", "[[Dr A]]", 9),
      blocked("REQ-3", "[[Dr B]]", 4),
    ]);
    // Wikilink brackets are stripped for the chart label; the note keeps them.
    expect(labels(series)).toEqual(["Dr A", "Dr B"]);
    expect(series.slices[0]?.note).toBe("longest 9 days");
  });

  it("states the cut rather than truncating in silence", () => {
    const many = Array.from({ length: 5 }, (_, i) => blocked(`REQ-${i}`, `[[Dr ${i}]]`, i + 1));
    const series = topBlockingParties(many, 2);
    expect(series.slices).toHaveLength(2);
    expect(series.denominator).toContain("5 parties");
    expect(series.denominator).toContain("top 2 shown");
  });
});

describe("workloadByHat", () => {
  const hats = [
    { id: "hod", label: "Head of SCDB" },
    { id: "biostat", label: "Biostatistician" },
  ];

  it("shows unfiled and misfiled work instead of dropping it", () => {
    // A hat total that quietly excludes work is worse than no total: the
    // unhatted request is the one nobody has looked at.
    const series = workloadByHat(
      [
        stuck("REQ-1", "triage", 1, { hat: "hod" }),
        stuck("REQ-2", "triage", 1, { hat: "" }),
        stuck("REQ-3", "triage", 1, { hat: "hdo" }),
      ],
      hats,
    );
    expect(valueFor(series, "Head of SCDB")).toBe(1);
    expect(valueFor(series, "No hat set")).toBe(1);
    expect(valueFor(series, "Unrecognised hat")).toBe(1);
    // Every request is accounted for somewhere on the chart.
    expect(series.slices.reduce((sum, slice) => sum + slice.value, 0)).toBe(3);
  });

  it("omits the unfiled rows when there are none", () => {
    const series = workloadByHat([stuck("REQ-1", "triage", 1, { hat: "hod" })], hats);
    expect(labels(series)).toEqual(["Head of SCDB", "Biostatistician"]);
  });
});

describe("governanceRisk", () => {
  it("uses the spec's own gates rather than a second definition", () => {
    // In `awaiting-approval` the only non-holding routes are `approved` (gated
    // on a current IRB) and the escape hatches. Strip the IRB and the approval
    // route shuts, but on-hold and withdrawn stay open — so this is partly
    // blocked, not blocked.
    const noIrb = stuck("REQ-1", "awaiting-approval", 5, {
      governance: { identifiers: "none" },
    });
    const risk = governanceRisk([noIrb], spec, NOW);
    expect(risk.blocked).toHaveLength(0);
    expect(risk.partly).toHaveLength(1);
    expect(risk.byGate.slices[0]?.label).toContain("Approved");
    expect(risk.byGate.slices[0]?.label).toContain("IRB");
  });

  it("counts a request as blocked only when every onward move is shut", () => {
    // From `qc` the declared routes are `delivered` (gated on an output and a
    // delivery method) and back to `extraction` (gated on identifiers/DUA).
    // Identifiable data with no DUA and no output shuts both.
    const shut = stuck("REQ-2", "qc", 5, {
      governance: { identifiers: "direct" },
      outputs: [],
    });
    const risk = governanceRisk([shut], spec, NOW);
    expect(risk.blocked.map((v) => v.request.id)).toEqual(["REQ-2"]);
    expect(risk.byGate.slices).toHaveLength(2);
  });

  it("counts a clear request as clear", () => {
    const clear = stuck("REQ-3", "triage", 1);
    const risk = governanceRisk([clear], spec, NOW);
    expect(risk.clear).toBe(1);
    expect(risk.byGate.slices).toHaveLength(0);
  });

  it("does not assess what it cannot: completed requests and a missing spec", () => {
    const done = stuck("REQ-4", "delivered", 1);
    expect(governanceRisk([done], spec, NOW).notAssessed).toBe(1);
    expect(governanceRisk([stuck("REQ-5", "triage", 1)], null, NOW).notAssessed).toBe(1);
  });
});

describe("turnaroundTrend", () => {
  // No `received`: the first history entry is a full timestamp, so turnaround
  // comes out in whole days rather than picking up the half-day offset between
  // a bare date (midnight) and the fixture's noon.
  const delivered = (id: string, arrivedDaysAgo: number, deliveredDaysAgo: number) => {
    const built = requestFrontmatter({
      id,
      stage: "delivered",
      due: "2099-01-01",
      history: [
        { at: iso(arrivedDaysAgo), to: "intake", by: "yh" },
        { at: iso(deliveredDaysAgo), to: "delivered", by: "yh" },
      ],
    });
    delete built["received"];
    delete built["blocked_on"];
    delete built["blocked_since"];
    const { request } = parseRequest(built);
    return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
  };

  it("buckets by the month a request completed, not the month it arrived", () => {
    // Arrived 70 days before NOW, delivered 5 days before it. Grouping under
    // arrival would credit the throughput to the wrong month and leave the
    // current one permanently understated.
    const trend = turnaroundTrend([delivered("REQ-1", 70, 5)], { now: NOW, months: 4 });
    const withData = trend.points.filter((point) => point.value !== null);
    expect(withData).toHaveLength(1);
    expect(withData[0]?.key).toBe("2026-07");
    expect(withData[0]?.value).toBe(65);
  });

  it("keeps empty months as gaps rather than dropping them", () => {
    const trend = turnaroundTrend([delivered("REQ-1", 70, 5)], { now: NOW, months: 4 });
    expect(trend.points).toHaveLength(4);
    expect(trend.points.filter((point) => point.value === null)).toHaveLength(3);
  });

  it("ends on the current month", () => {
    const trend = turnaroundTrend([], { now: NOW, months: 3 });
    expect(trend.points[trend.points.length - 1]?.key).toBe("2026-07");
    expect(trend.points.map((p) => p.key)).toEqual(["2026-05", "2026-06", "2026-07"]);
  });

  it("takes the median when a month held several requests", () => {
    const trend = turnaroundTrend(
      [delivered("REQ-1", 15, 5), delivered("REQ-2", 25, 5), delivered("REQ-3", 45, 5)],
      { now: NOW, months: 2 },
    );
    const july = trend.points.find((point) => point.key === "2026-07");
    expect(july?.count).toBe(3);
    expect(july?.value).toBe(20);
  });
});
