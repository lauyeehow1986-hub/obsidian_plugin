import { describe, expect, it } from "vitest";
import type { ChartSeries, TrendSeries } from "../request/analytics";
import { barChart, trendChart } from "./charts";
import { textOf, toHtml } from "./element";

function series(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    id: "test",
    title: "Queue by stage",
    unit: "requests",
    denominator: "9 live requests",
    ordered: true,
    empty: "Nothing yet.",
    slices: [
      { key: "triage", label: "SCDB triage", value: 2 },
      { key: "approval", label: "Awaiting approval", value: 4, emphasis: { value: 1, label: "1 overdue" } },
    ],
    ...overrides,
  };
}

function trend(overrides: Partial<TrendSeries> = {}): TrendSeries {
  return {
    id: "trend",
    title: "Turnaround trend",
    unit: "days, median",
    denominator: "6 requests completed in the last 4 months",
    empty: "Nothing completed.",
    points: [
      { key: "2026-04", label: "26-04", value: 20, count: 2 },
      { key: "2026-05", label: "26-05", value: null, count: 0 },
      { key: "2026-06", label: "26-06", value: 10, count: 1 },
      { key: "2026-07", label: "26-07", value: 15, count: 3 },
    ],
    ...overrides,
  };
}

describe("barChart", () => {
  it("prints the unit and the denominator, always (§6)", () => {
    expect(textOf(barChart(series()))).toContain("requests · 9 live requests");
  });

  it("draws bars from zero, scaled to the largest", () => {
    const html = toHtml(barChart(series()));
    expect(html).toContain('style="width:50.00%"'); // 2 of 4
    expect(html).toContain('style="width:100.00%"'); // 4 of 4
  });

  it("nests the emphasis inside the bar, so it also starts at zero", () => {
    // 1 overdue of 4 in that bar = 25% of the bar, not 25% of the chart.
    const html = toHtml(barChart(series()));
    expect(html).toContain('class="scdb-bar__emphasis" style="width:25.00%"');
  });

  it("spells the emphasis out in words as well as shading it", () => {
    // §6: never colour alone. A colour-blind reader must lose nothing.
    expect(textOf(barChart(series()))).toContain("1 overdue");
  });

  it("keeps the series order rather than sorting by value", () => {
    const html = toHtml(barChart(series()));
    expect(html.indexOf("SCDB triage")).toBeLessThan(html.indexOf("Awaiting approval"));
  });

  it("shows the series' own empty sentence when there is nothing to draw", () => {
    const html = toHtml(barChart(series({ slices: [] })));
    expect(html).toContain("Nothing yet.");
    expect(html).not.toContain("scdb-bar__track");
  });

  it("does not draw a chart of zero-length bars", () => {
    const all = series({ slices: [{ key: "a", label: "A", value: 0 }] });
    expect(toHtml(barChart(all))).toContain("every requests count is zero");
  });

  it("escapes a label that came out of a note", () => {
    const nasty = series({ slices: [{ key: "x", label: '<img src=x onerror="e">', value: 1 }] });
    const html = toHtml(barChart(nasty));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("trendChart", () => {
  it("breaks the line at months with nothing completed", () => {
    // Two runs, not one line drawn straight across the gap: a continuous line
    // would assert a trend through a month where nothing happened.
    const html = toHtml(trendChart(trend()));
    expect(html.match(/<polyline/g) ?? []).toHaveLength(1);
    expect(html.match(/<circle/g) ?? []).toHaveLength(2); // lone April point + latest
  });

  it("starts the y-axis at zero", () => {
    // The 0 tick and the max tick are both written on the chart, so the reader
    // can see the baseline is zero rather than take it on trust.
    const text = textOf(trendChart(trend()));
    expect(text).toContain("0");
    expect(text).toContain("20");
  });

  it("labels the latest value on the chart and restates it in words", () => {
    const text = textOf(trendChart(trend()));
    expect(text).toContain("Latest 26-07: 15 days, median from 3 requests");
    expect(text).toContain("Best 10, worst 20");
  });

  it("falls back to the empty sentence when no month has a value", () => {
    const blank = trend({
      points: [{ key: "2026-07", label: "26-07", value: null, count: 0 }],
    });
    const html = toHtml(trendChart(blank));
    expect(html).toContain("Nothing completed.");
    expect(html).not.toContain("<svg");
  });

  it("survives a single measured month without dividing by zero", () => {
    const one = trend({ points: [{ key: "2026-07", label: "26-07", value: 5, count: 1 }] });
    const html = toHtml(trendChart(one));
    expect(html).toContain("<circle");
    expect(html).not.toContain("NaN");
  });

  it("survives every measured month being zero", () => {
    const flat = trend({
      points: [
        { key: "2026-06", label: "26-06", value: 0, count: 1 },
        { key: "2026-07", label: "26-07", value: 0, count: 1 },
      ],
    });
    expect(toHtml(trendChart(flat))).not.toContain("NaN");
  });
});
