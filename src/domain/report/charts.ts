/**
 * Chart layout (CLAUDE.md §6, §7 A3).
 *
 * Built as neutral element trees so the cockpit and the static HTML export draw
 * the identical chart from the identical numbers — see `element.ts`.
 *
 * The design rules from §6 are enforced here rather than trusted to each call
 * site: no pie charts, no gradients, bars always from zero, categorical order
 * preserved from the series rather than re-sorted, the unit and the denominator
 * printed on every chart, and any emphasised portion of a bar spelled out in
 * words as well as shaded — a colour-blind reader must lose nothing.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { ChartSeries, TrendSeries } from "../request/analytics";
import { el, type El } from "./element";

function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/** "23", "1.5" — one decimal at most, never trailing zeros. */
function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function caption(title: string, unit: string, denominator: string): El {
  return el(
    "figcaption",
    { class: "scdb-chart__caption" },
    el("span", { class: "scdb-chart__title" }, title),
    // Unit and denominator, always. A bar of length 4 means nothing without
    // both, and "obvious from context" is how a chart ends up in a report
    // saying something it never said on screen.
    el("span", { class: "scdb-chart__meta" }, `${unit} · ${denominator}`),
  );
}

function emptyState(message: string): El {
  return el("p", { class: "scdb-empty" }, message);
}

/**
 * A horizontal bar chart.
 *
 * Horizontal, not vertical: category labels read left-to-right at any width,
 * and the chart degrades to a legible list at 300px instead of a row of
 * unlabelled columns (§6, usable in a sidebar).
 */
export function barChart(series: ChartSeries): El {
  const max = Math.max(0, ...series.slices.map((slice) => slice.value));
  const drawable = series.slices.length > 0 && max > 0;

  return el(
    "figure",
    { class: "scdb-chart", "data-chart": series.id },
    caption(series.title, series.unit, series.denominator),
    drawable
      ? el(
          "ul",
          { class: "scdb-bars" },
          series.slices.map((slice) =>
            el(
              "li",
              { class: "scdb-bar" },
              el("span", { class: "scdb-bar__label" }, slice.label),
              el(
                "span",
                { class: "scdb-bar__track" },
                el(
                  "span",
                  {
                    class: "scdb-bar__fill",
                    style: `width:${percent(slice.value, max).toFixed(2)}%`,
                  },
                  // Nested, so the emphasised part starts at zero like the bar
                  // it sits in rather than floating somewhere along it.
                  slice.emphasis && slice.emphasis.value > 0
                    ? el("span", {
                        class: "scdb-bar__emphasis",
                        style: `width:${percent(slice.emphasis.value, slice.value).toFixed(2)}%`,
                      })
                    : null,
                ),
              ),
              // Direct labelling, not a legend and not an axis to read across.
              el("span", { class: "scdb-bar__value scdb-num" }, number(slice.value)),
              slice.emphasis || slice.note
                ? el(
                    "span",
                    { class: "scdb-bar__note" },
                    [slice.emphasis?.label, slice.note].filter(Boolean).join(" · "),
                  )
                : null,
            ),
          ),
        )
      : emptyState(
          series.slices.length === 0
            ? series.empty
            : `Nothing to draw: every ${series.unit.split(",")[0]} count is zero.`,
        ),
  );
}

/* ---------------------------------------------------------------- trend -- */

// A small viewBox on purpose: an SVG scales its text with the drawing, so a
// wide viewBox squeezed into a 300px sidebar renders 5px labels. At roughly
// sidebar size the chart is 1:1, and growing wider only makes it easier to read.
const W = 320;
const H = 120;
const PAD = { top: 10, right: 8, bottom: 18, left: 26 };

/**
 * A line chart over calendar months.
 *
 * The y-axis starts at zero — the same rule as bars, for the same reason: a
 * truncated axis turns a 4% change into a cliff, and this number ends up in
 * front of people making staffing decisions.
 *
 * Months with nothing completed break the line rather than being skipped. A
 * line drawn straight across a gap asserts a trend through months where
 * nothing happened.
 */
export function trendChart(series: TrendSeries): El {
  const measured = series.points.filter(
    (point): point is typeof point & { value: number } => point.value !== null,
  );

  if (measured.length === 0) {
    return el(
      "figure",
      { class: "scdb-chart", "data-chart": series.id },
      caption(series.title, series.unit, series.denominator),
      emptyState(series.empty),
    );
  }

  const max = Math.max(...measured.map((point) => point.value));
  const top = max <= 0 ? 1 : max;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = series.points.length > 1 ? plotW / (series.points.length - 1) : 0;

  const x = (index: number) => PAD.left + index * step;
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;

  // Split into runs of consecutive measured months, so a gap is a gap.
  const runs: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  series.points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, value: point.value });
  });
  if (run.length > 0) runs.push(run);

  const last = measured[measured.length - 1]!;
  const lastIndex = series.points.findIndex((point) => point.key === last.key);

  // Every third month, plus the last, or twelve labels collide in a sidebar.
  const labelled = series.points.filter(
    (_, index) => index % 3 === 0 || index === series.points.length - 1,
  );

  return el(
    "figure",
    { class: "scdb-chart", "data-chart": series.id },
    caption(series.title, series.unit, series.denominator),
    el(
      "svg",
      {
        class: "scdb-trend",
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "xMidYMid meet",
        role: "img",
        "aria-label": `${series.title}: ${series.unit}, ${series.denominator}. Latest ${number(last.value)}.`,
      },
      // Baseline and top gridline, labelled — two lines is enough to read a
      // value off, and more would be chartjunk at this size.
      el("line", {
        class: "scdb-trend__axis",
        x1: PAD.left,
        y1: y(0),
        x2: W - PAD.right,
        y2: y(0),
      }),
      el("line", {
        class: "scdb-trend__grid",
        x1: PAD.left,
        y1: y(top),
        x2: W - PAD.right,
        y2: y(top),
      }),
      el("text", { class: "scdb-trend__tick", x: PAD.left - 4, y: y(0) + 3, "text-anchor": "end" }, "0"),
      el(
        "text",
        { class: "scdb-trend__tick", x: PAD.left - 4, y: y(top) + 3, "text-anchor": "end" },
        number(top),
      ),
      runs.map((points, index) =>
        points.length === 1
          ? el("circle", {
              class: "scdb-trend__dot",
              key: `dot-${index}`,
              cx: x(points[0]!.index),
              cy: y(points[0]!.value),
              r: 2.5,
            })
          : el("polyline", {
              class: "scdb-trend__line",
              key: `run-${index}`,
              points: points.map((point) => `${x(point.index)},${y(point.value)}`).join(" "),
            }),
      ),
      // The latest value is the one anybody actually reads off a trend, so it
      // is written on the chart instead of estimated against the axis.
      el("circle", {
        class: "scdb-trend__dot scdb-trend__dot--last",
        cx: x(lastIndex),
        cy: y(last.value),
        r: 3,
      }),
      el(
        "text",
        {
          class: "scdb-trend__value",
          x: Math.min(x(lastIndex) + 5, W - PAD.right),
          y: Math.max(y(last.value) - 5, PAD.top),
          "text-anchor": x(lastIndex) > W / 2 ? "end" : "start",
        },
        number(last.value),
      ),
      labelled.map((point) => {
        // The outermost ticks are anchored inwards, or half of "26-07" hangs
        // off the edge of the viewBox and is clipped.
        const index = series.points.indexOf(point);
        const anchor =
          index === 0 ? "start" : index === series.points.length - 1 ? "end" : "middle";
        return el(
          "text",
          {
            class: "scdb-trend__tick",
            key: `tick-${point.key}`,
            x: x(index),
            y: H - 6,
            "text-anchor": anchor,
          },
          point.label,
        );
      }),
    ),
    el(
      "p",
      { class: "scdb-chart__foot" },
      `Latest ${last.label}: ${number(last.value)} ${series.unit} from ` +
        `${last.count} request${last.count === 1 ? "" : "s"}. ` +
        `Best ${number(Math.min(...measured.map((p) => p.value)))}, ` +
        `worst ${number(max)}.`,
    ),
  );
}
