import { describe, expect, it } from "vitest";
import type { TrendSeries } from "../request/analytics";
import type { ChartSeries } from "../request/analytics";
import type { ReportDocument } from "./document";
import { el } from "./element";
import { renderMarkdown, REPORT_NOTE_TYPE } from "./markdown";
import { barChartSvg, trendChartSvg } from "./svg";

const OPTIONS = { templateId: "demo", period: "2026-07", study: "", rows: 3 };

function doc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    title: "A report",
    subtitle: "3 rows",
    generatedAt: "2026-07-28 12:00",
    sections: [],
    ...overrides,
  };
}

describe("renderMarkdown — the note itself", () => {
  it("opens with frontmatter the index can read", () => {
    const out = renderMarkdown(doc(), OPTIONS);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain(`type: ${REPORT_NOTE_TYPE}`);
    expect(out).toContain('template: "demo"');
    expect(out).toContain('period: "2026-07"');
    expect(out).toContain("rows: 3");
    // Nothing was passed, so nothing is claimed.
    expect(out).not.toContain("study:");
  });

  it("quotes a title that would otherwise parse as something else", () => {
    const out = renderMarkdown(doc({ title: 'Effort: "Q3" [draft]' }), OPTIONS);
    expect(out).toContain('title: "Effort: \\"Q3\\" [draft]"');
  });

  it("carries the same provenance caveat the HTML export does", () => {
    // §5.1 — a markdown note is the form most likely to be copied onwards, so
    // it is the one that can least afford to leave the caveat behind.
    expect(renderMarkdown(doc(), OPTIONS)).toContain("not an official record");
  });

  it("prints the heading of a headed section and nothing for an unheaded one", () => {
    const out = renderMarkdown(
      doc({
        sections: [
          { heading: "One", lede: "A line", body: el("p", {}, "Body.") },
          { heading: "", body: el("p", {}, "Loose.") },
        ],
      }),
      OPTIONS,
    );
    expect(out).toContain("## One");
    expect(out).toContain("*A line*");
    expect(out).toContain("Loose.");
    expect(out).not.toContain("## \n");
  });
});

describe("renderMarkdown — tables", () => {
  const table = el(
    "table",
    {},
    el("thead", {}, el("tr", {}, el("th", {}, "Study"), el("th", { class: "num" }, "Hours"))),
    el(
      "tbody",
      {},
      el("tr", {}, el("td", {}, "A | B"), el("td", { class: "num" }, "1.5")),
      el("tr", {}, el("td", {}, "Other"), el("td", { class: "num" }, "2")),
    ),
  );

  it("becomes a pipe table with numbers right-aligned", () => {
    const out = renderMarkdown(doc({ sections: [{ heading: "T", body: table }] }), OPTIONS);
    expect(out).toContain("| Study | Hours |");
    expect(out).toContain("| --- | ---: |");
    expect(out).toContain("| Other | 2 |");
  });

  it("escapes a pipe in a cell rather than letting it split the row", () => {
    const out = renderMarkdown(doc({ sections: [{ heading: "T", body: table }] }), OPTIONS);
    expect(out).toContain("A \\| B");
  });
});

describe("renderMarkdown — lists and escaping", () => {
  it("numbers an ordered list, which is how a publication list reads", () => {
    const body = el("ol", {}, el("li", {}, "Author A. A paper. Journal. 2026."));
    const out = renderMarkdown(doc({ sections: [{ heading: "P", body }] }), OPTIONS);
    expect(out).toContain("1. Author A. A paper. Journal. 2026.");
  });

  it("escapes a leading character markdown would read as structure", () => {
    const body = el("p", {}, "# not a heading");
    expect(renderMarkdown(doc({ sections: [{ heading: "P", body }] }), OPTIONS)).toContain(
      "\\# not a heading",
    );
  });

  it("leaves a hash alone in the middle of a sentence", () => {
    const body = el("p", {}, "Cohort #4 was delivered.");
    expect(renderMarkdown(doc({ sections: [{ heading: "P", body }] }), OPTIONS)).toContain(
      "Cohort #4 was delivered.",
    );
  });

  it("flattens a newline inside a cell so it cannot end the table", () => {
    const body = el(
      "table",
      {},
      el("thead", {}, el("tr", {}, el("th", {}, "A"))),
      el("tbody", {}, el("tr", {}, el("td", {}, "one\ntwo"))),
    );
    expect(renderMarkdown(doc({ sections: [{ heading: "T", body }] }), OPTIONS)).toContain(
      "| one two |",
    );
  });
});

describe("renderMarkdown — charts", () => {
  const bars: ChartSeries = {
    id: "effort-activity",
    title: "Effort by activity",
    unit: "hours",
    denominator: "1h 30m across 2 entries",
    slices: [
      { key: "extraction", label: "extraction", value: 1, note: "1 entry" },
      { key: "qc", label: "qc", value: 0.5, note: "1 entry" },
    ],
    empty: "No time was logged.",
    ordered: true,
  };

  const trend: TrendSeries = {
    id: "turnaround-trend",
    title: "Turnaround trend",
    unit: "days, median",
    denominator: "2 requests completed",
    points: [
      { key: "2026-06", label: "26-06", value: 10, count: 1 },
      { key: "2026-07", label: "26-07", value: null, count: 0 },
      { key: "2026-08", label: "26-08", value: 6, count: 1 },
    ],
    empty: "Nothing completed.",
  };

  it("passes an SVG through as the one piece of literal markup", () => {
    const out = renderMarkdown(
      doc({ sections: [{ heading: "C", body: barChartSvg(bars) }] }),
      OPTIONS,
    );
    expect(out).toContain("<svg");
    expect(out).toContain("</svg>");
    // Inherits the reader's text colour, so it is legible in light and dark.
    expect(out).toContain('fill="currentColor"');
    expect(out).not.toContain("class=");
  });

  it("labels every bar in words as well as drawing it", () => {
    const out = renderMarkdown(
      doc({ sections: [{ heading: "C", body: barChartSvg(bars) }] }),
      OPTIONS,
    );
    expect(out).toContain("extraction");
    expect(out).toContain("Effort by activity");
    expect(out).toContain("1h 30m across 2 entries");
  });

  it("says what happened instead of drawing an empty chart", () => {
    const out = renderMarkdown(
      doc({
        sections: [{ heading: "C", body: barChartSvg({ ...bars, slices: [] }) }],
      }),
      OPTIONS,
    );
    expect(out).not.toContain("<svg");
    expect(out).toContain("No time was logged.");
  });

  it("draws a trend with its gap intact, and states the latest value in words", () => {
    const out = renderMarkdown(
      doc({ sections: [{ heading: "C", body: trendChartSvg(trend) }] }),
      OPTIONS,
    );
    expect(out).toContain("<svg");
    // Two runs, not one line drawn across the empty month.
    expect(out.match(/<circle/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("Latest 26-08: 6 days, median");
    expect(out).toContain("Best 6, worst 10.");
  });

  it("escapes note text on its way into an SVG label", () => {
    const out = renderMarkdown(
      doc({
        sections: [
          {
            heading: "C",
            body: barChartSvg({
              ...bars,
              slices: [{ key: "x", label: "<script>alert(1)</script>", value: 1 }],
            }),
          },
        ],
      }),
      OPTIONS,
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
