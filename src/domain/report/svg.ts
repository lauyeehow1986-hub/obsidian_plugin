/**
 * Charts as standalone SVG, for the markdown report (CLAUDE.md §7 B7).
 *
 * A second renderer for the same series, and the reason is that a markdown note
 * has **no stylesheet**. `charts.ts` hangs everything on classes that
 * `styles.css` and the HTML export's inline `<style>` fill in; drop that markup
 * into a note and you get a list of tracks with no height and bars with no
 * colour. So this file draws with presentation attributes and explicit
 * geometry instead.
 *
 * Only the markup is new. The trend's arithmetic comes from `trendGeometry`, so
 * the two renderers cannot place the same point differently — the failure that
 * matters here is two copies of one figure disagreeing, side by side, in front
 * of somebody who noticed.
 *
 * **`currentColor` throughout, never a fixed palette.** The note is read in
 * whatever theme the work laptop wears, light or dark, and a chart drawn in
 * #3a5bd9 on a dark theme is a chart nobody can read. Inheriting the text
 * colour costs nothing and is right in both. It also satisfies §6's "never
 * colour alone" for free: with one ink, every bar has to be labelled, and
 * every bar is.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { ChartSeries, TrendSeries } from "../request/analytics";
import { chartNumber, H, PAD, percent, trendGeometry, W } from "./charts";
import { el, type El, type Node } from "./element";

/* ------------------------------------------------------------------ bars -- */

const BAR_W = 640;
const ROW_H = 22;
const LABEL_W = 190;
const VALUE_W = 64;
const TOP = 8;

/**
 * SVG cannot wrap text, so a long study name would run under its own bar.
 *
 * Truncated rather than shrunk: a chart that silently uses a smaller font for
 * one row is harder to read than one that says a label was cut. The full text
 * goes in a `<title>`, which is the tooltip and what a screen reader announces.
 */
function clip(label: string, max = 26): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

function captionLines(title: string, unit: string, denominator: string): Node[] {
  return [
    el("text", { x: 0, y: 12, "font-size": 13, "font-weight": 600, fill: "currentColor" }, title),
    el(
      "text",
      { x: 0, y: 28, "font-size": 11, fill: "currentColor", opacity: 0.7 },
      `${unit} · ${denominator}`,
    ),
  ];
}

/**
 * A horizontal bar chart, drawn.
 *
 * Same rules as the themed version, restated because they are enforced here
 * rather than trusted to the caller: bars start at zero, category order is the
 * series' own, the unit and denominator are printed, and any emphasised
 * portion is spelled out in words beside the bar as well as shaded.
 */
export function barChartSvg(series: ChartSeries): El {
  const max = Math.max(0, ...series.slices.map((slice) => slice.value));
  const rows = series.slices.length;

  if (rows === 0 || max <= 0) {
    return el(
      "figure",
      { "data-chart": series.id },
      el("p", {}, `${series.title} — ${series.unit} · ${series.denominator}`),
      el(
        "p",
        {},
        rows === 0
          ? series.empty
          : `Nothing to draw: every ${series.unit.split(",")[0]} count is zero.`,
      ),
    );
  }

  const height = TOP + 34 + rows * ROW_H + 6;
  const trackX = LABEL_W;
  const trackW = BAR_W - LABEL_W - VALUE_W;

  const bars: Node[] = series.slices.flatMap((slice, index) => {
    const y = TOP + 34 + index * ROW_H;
    const width = (percent(slice.value, max) / 100) * trackW;
    const emphasis =
      slice.emphasis && slice.emphasis.value > 0
        ? (percent(slice.emphasis.value, slice.value) / 100) * width
        : 0;

    return [
      el(
        "text",
        { x: 0, y: y + 12, "font-size": 11, fill: "currentColor" },
        el("title", {}, slice.label),
        clip(slice.label),
      ),
      // The full-length track, so a short bar still reads as a proportion of
      // something rather than as a stub floating in white space.
      el("rect", {
        x: trackX,
        y: y + 3,
        width: trackW,
        height: 12,
        rx: 2,
        fill: "currentColor",
        opacity: 0.08,
      }),
      el("rect", {
        x: trackX,
        y: y + 3,
        width: Math.max(width, 1),
        height: 12,
        rx: 2,
        fill: "currentColor",
        opacity: 0.55,
      }),
      emphasis > 0
        ? el("rect", {
            x: trackX,
            y: y + 3,
            width: Math.max(emphasis, 1),
            height: 12,
            rx: 2,
            fill: "currentColor",
            opacity: 0.95,
          })
        : null,
      el(
        "text",
        { x: BAR_W, y: y + 13, "font-size": 11, "text-anchor": "end", fill: "currentColor" },
        chartNumber(slice.value),
      ),
    ];
  });

  const notes = series.slices
    .map((slice) => [slice.label, [slice.emphasis?.label, slice.note].filter(Boolean).join(" · ")])
    .filter((pair) => pair[1] !== "");

  return el(
    "figure",
    { "data-chart": series.id },
    el(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: `0 0 ${BAR_W} ${height}`,
        width: "100%",
        role: "img",
        "aria-label": `${series.title}: ${series.unit}, ${series.denominator}.`,
      },
      ...captionLines(series.title, series.unit, series.denominator),
      ...bars,
    ),
    // Emphasis and per-row notes in words, under the chart rather than crammed
    // into it. Shading alone is never the only carrier of a fact (§6).
    notes.length === 0
      ? null
      : el(
          "p",
          {},
          notes.map((pair) => `${pair[0]}: ${pair[1]}`).join(" · "),
        ),
  );
}

/* ----------------------------------------------------------------- trend -- */

export function trendChartSvg(series: TrendSeries): El {
  const { drawable, top, x, y, runs, last, lastIndex, min, max, labelled } =
    trendGeometry(series);

  if (!drawable) {
    return el(
      "figure",
      { "data-chart": series.id },
      el("p", {}, `${series.title} — ${series.unit} · ${series.denominator}`),
      el("p", {}, series.empty),
    );
  }

  // The plot's own coordinates start at zero; the caption is two lines above
  // it, so the whole drawing is shifted down rather than the geometry being
  // recomputed for this surface.
  const OFFSET = 34;

  return el(
    "figure",
    { "data-chart": series.id },
    el(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: `0 0 ${W} ${H + OFFSET}`,
        width: "100%",
        role: "img",
        "aria-label": `${series.title}: ${series.unit}, ${series.denominator}. Latest ${chartNumber(last.value)}.`,
      },
      ...captionLines(series.title, series.unit, series.denominator),
      el(
      "g",
      { transform: `translate(0 ${OFFSET})` },
      el("line", {
        x1: PAD.left,
        y1: y(0),
        x2: W - PAD.right,
        y2: y(0),
        stroke: "currentColor",
        "stroke-width": 0.75,
        opacity: 0.6,
      }),
      el("line", {
        x1: PAD.left,
        y1: y(top),
        x2: W - PAD.right,
        y2: y(top),
        stroke: "currentColor",
        "stroke-width": 0.75,
        opacity: 0.2,
      }),
      el(
        "text",
        { x: PAD.left - 4, y: y(0) + 3, "text-anchor": "end", "font-size": 8, fill: "currentColor", opacity: 0.7 },
        "0",
      ),
      el(
        "text",
        { x: PAD.left - 4, y: y(top) + 3, "text-anchor": "end", "font-size": 8, fill: "currentColor", opacity: 0.7 },
        chartNumber(top),
      ),
      runs.map((points, index) =>
        points.length === 1
          ? el("circle", {
              key: `dot-${index}`,
              cx: x(points[0]!.index),
              cy: y(points[0]!.value),
              r: 2.5,
              fill: "currentColor",
            })
          : el("polyline", {
              key: `run-${index}`,
              points: points.map((point) => `${x(point.index)},${y(point.value)}`).join(" "),
              fill: "none",
              stroke: "currentColor",
              "stroke-width": 1.5,
              "stroke-linejoin": "round",
            }),
      ),
      el("circle", { cx: x(lastIndex), cy: y(last.value), r: 3, fill: "currentColor" }),
      el(
        "text",
        {
          x: Math.min(x(lastIndex) + 5, W - PAD.right),
          y: Math.max(y(last.value) - 5, PAD.top),
          "text-anchor": x(lastIndex) > W / 2 ? "end" : "start",
          "font-size": 9,
          fill: "currentColor",
        },
        chartNumber(last.value),
      ),
      labelled.map(({ key, label, index }) =>
        el(
          "text",
          {
            key: `tick-${key}`,
            x: x(index),
            y: H - 6,
            "text-anchor":
              index === 0 ? "start" : index === series.points.length - 1 ? "end" : "middle",
            "font-size": 8,
            fill: "currentColor",
            opacity: 0.7,
          },
          label,
        ),
      ),
      ),
    ),
    el(
      "p",
      {},
      `Latest ${last.label}: ${chartNumber(last.value)} ${series.unit} from ` +
        `${last.count} request${last.count === 1 ? "" : "s"}. ` +
        `Best ${chartNumber(min)}, worst ${chartNumber(max)}.`,
    ),
  );
}
