import { describe, expect, it } from "vitest";
import type { TimeEntry } from "../effort/entry";
import { parseProfileNote, type ProfileNote } from "../profile/profile";
import { parsePublication, type PublicationNote } from "../publication/publication";
import { requestMetrics } from "../request/dwell";
import type { RequestView } from "../request/holdup";
import { parseRequest } from "../request/request";
import { NOW, requestFrontmatter, testSpec } from "../request/testFixtures";
import { DAY_MS } from "../time/dates";
import { BUILT_IN_TEMPLATES } from "./builtins";
import { composeReport, reportRowCount, windowFor, type ReportData } from "./compose";
import { renderDocument } from "./document";
import { textOf } from "./element";
import type { ReportTemplate } from "./template";

const spec = testSpec();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();
/** NOW is in July 2026 — see `request/testFixtures`. */
const MONTH = new Date(NOW).toISOString().slice(0, 7);

function view(id: string, stage: string, days: number, extra: Record<string, unknown> = {}) {
  const built = requestFrontmatter({
    id,
    stage,
    due: "2099-01-01",
    history: [
      { at: iso(days + 10), to: "triage", by: "yh" },
      { at: iso(days), to: stage, by: "yh" },
    ],
    ...extra,
  });
  if (extra["blocked_on"] === undefined) {
    delete built["blocked_on"];
    delete built["blocked_since"];
  }
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

const VIEWS: RequestView[] = [
  view("REQ-1", "triage", 1, { study: "[[Example Registry]]", effort_estimate_hours: 6 }),
  view("REQ-2", "awaiting-approval", 40, {
    blocked_on: "[[Dr A Tan]]",
    blocked_since: iso(40),
    study: "[[Example Registry]]",
  }),
  view("REQ-3", "delivered", 3, { study: "[[Other Study]]" }),
];

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    date: `${MONTH}-14`,
    start: "09:00",
    end: "10:00",
    mins: 60,
    person: "yh",
    ref: "REQ-1",
    activity: "extraction",
    study: "[[Example Registry]]",
    costCentre: "RC",
    note: "",
    ...overrides,
  };
}

function publication(overrides: Record<string, unknown> = {}): PublicationNote {
  return parsePublication(`85 Publications/${String(overrides["id"] ?? "PUB-1")}.md`, {
    type: "publication",
    id: "PUB-1",
    title: "A synthetic paper",
    stage: "published",
    journal: "Journal of Invented Results",
    authors: ["[[A Author]]"],
    studies: ["[[Example Registry]]"],
    published: "2026-02-01",
    scdb_supported: true,
    ...overrides,
  });
}

function profile(frontmatter: Record<string, unknown>, path = "84 Profile/x.md"): ProfileNote {
  const note = parseProfileNote(path, frontmatter);
  if (note === null) throw new Error("expected a profile note");
  return note;
}

function data(overrides: Partial<ReportData> = {}): ReportData {
  return {
    views: VIEWS,
    allViews: VIEWS,
    spec,
    entries: [entry(), entry({ activity: "qc", mins: 30 }), entry({ date: "2019-01-01" })],
    publications: [publication(), publication({ id: "PUB-2", scdb_supported: false })],
    profile: [profile({ type: "award", title: "Invented Prize", year: 2025 })],
    rows: [],
    fields: [],
    citationFormat: "vancouver",
    window: windowFor("month", MONTH, NOW),
    study: "",
    now: NOW,
    generatedAt: "2026-07-28 12:00",
    scope: "",
    charts: "html",
    ...overrides,
  };
}

function template(overrides: Partial<ReportTemplate> = {}): ReportTemplate {
  return {
    id: "t",
    label: "T",
    description: "",
    period: "month",
    study: false,
    title: "T — {period}",
    path: "",
    sections: [],
    ...overrides,
  };
}

describe("windowFor", () => {
  it("reads a month and a year", () => {
    expect(windowFor("month", "2026-07", NOW)).toMatchObject({
      label: "July 2026",
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(windowFor("year", "2026", NOW)).toMatchObject({
      label: "2026",
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("gets February right, including in a leap year", () => {
    expect(windowFor("month", "2026-02", NOW).to).toBe("2026-02-28");
    expect(windowFor("month", "2028-02", NOW).to).toBe("2028-02-29");
  });

  it("falls back to the current period rather than to a title that lies", () => {
    expect(windowFor("month", "2026-13", NOW).value).toBe(MONTH);
    expect(windowFor("month", "rubbish", NOW).value).toBe(MONTH);
  });

  it("covers everything when the template asks for no period", () => {
    expect(windowFor("all", "", NOW)).toMatchObject({ label: "all time", from: "", to: "" });
  });
});

describe("composeReport", () => {
  it("substitutes the period and the study into the title", () => {
    const document = composeReport(
      template({ title: "{study} — {period}" }),
      data({ study: "[[Example Registry]]" }),
    );
    expect(document.title).toBe("Example Registry — July 2026");
  });

  it("says 'every study' rather than leaving a hole when none was picked", () => {
    expect(composeReport(template({ title: "{study}" }), data()).title).toBe("every study");
  });

  it("keeps an unheaded section unheaded", () => {
    const document = composeReport(
      template({ sections: [{ heading: "", lede: "", blocks: [{ kind: "portfolio" }] }] }),
      data(),
    );
    expect(document.sections[0]?.heading).toBe("");
    expect(renderDocument(document)).not.toContain("<h2></h2>");
  });

  it("splits prose on blank lines and substitutes into it too", () => {
    const document = composeReport(
      template({
        sections: [
          { heading: "H", lede: "", blocks: [{ kind: "prose", text: "One {period}.\n\nTwo." }] },
        ],
      }),
      data(),
    );
    expect(textOf(document.sections[0]!.body)).toBe("One July 2026. Two.");
  });
});

describe("blocks", () => {
  const build = (block: Parameters<typeof composeReport>[0]["sections"][0]["blocks"][0], over: Partial<ReportData> = {}) =>
    textOf(
      composeReport(template({ sections: [{ heading: "H", lede: "", blocks: [block] }] }), data(over))
        .sections[0]!.body,
    );

  it("the queue lists live requests and leaves completed ones out", () => {
    const text = build({ kind: "request-queue" });
    expect(text).toContain("REQ-1");
    expect(text).toContain("REQ-2");
    expect(text).not.toContain("REQ-3");
  });

  it("effort respects the window and totals what it shows", () => {
    const text = build({ kind: "effort", by: "activity" });
    expect(text).toContain("extraction");
    expect(text).toContain("qc");
    // The 2019 entry is outside the month, so 1.5 h is the total, not 2.5.
    expect(text).toContain("1.5");
    expect(text).toContain("Total");
  });

  it("effort says which study and which month found nothing", () => {
    const text = build(
      { kind: "effort", by: "activity" },
      { study: "[[Example Registry]]", window: windowFor("month", "2001-01", NOW) },
    );
    expect(text).toContain("Example Registry");
    expect(text).toContain("January 2001");
  });

  it("estimate-vs-actual compares against all time logged, not the window's", () => {
    const text = build({ kind: "estimate-vs-actual" });
    expect(text).toContain("REQ-1");
    // Three entries at 60 + 30 + 60 minutes are all against REQ-1, including
    // the one from 2019: an estimate is for the whole piece of work.
    expect(text).toContain("2h 30m");
  });

  it("publications list only the window's year", () => {
    const inWindow = build(
      { kind: "publications", scdbOnly: false, stages: null },
      { window: windowFor("year", "2026", NOW) },
    );
    expect(inWindow).toContain("A synthetic paper");

    const outside = build(
      { kind: "publications", scdbOnly: false, stages: null },
      { window: windowFor("year", "2001", NOW) },
    );
    expect(outside).toContain("No manuscript is accepted");
  });

  it("the scdb-only cut says so in the lede", () => {
    const text = build(
      { kind: "publications", scdbOnly: true, stages: null },
      { window: windowFor("all", "", NOW) },
    );
    expect(text).toContain("facility-supported only");
    expect(text).toContain("1 reference");
  });

  it("the CV explains what to do when there is nothing to build from", () => {
    const text = build({ kind: "cv", layout: null }, { profile: [], publications: [] });
    expect(text).toContain("84 Profile/");
  });

  it("the portfolio names its themes and its collaborators", () => {
    const text = build({ kind: "portfolio" });
    expect(text).toContain("Example Registry");
    expect(text).toContain("A Author");
  });

  it("bottlenecks name who the holdup is with", () => {
    expect(build({ kind: "bottlenecks" })).toContain("Dr A Tan");
  });
});

describe("reportRowCount", () => {
  it("counts what a reader would count, once per block kind", () => {
    const queue = template({
      sections: [
        { heading: "A", lede: "", blocks: [{ kind: "request-queue" }] },
        // Two request-driven blocks must not double the count.
        { heading: "B", lede: "", blocks: [{ kind: "turnaround" }] },
      ],
    });
    expect(reportRowCount(queue, data())).toBe(3);
  });

  it("counts effort rows inside the window only", () => {
    const effort = template({
      sections: [{ heading: "A", lede: "", blocks: [{ kind: "effort", by: "activity" }] }],
    });
    expect(reportRowCount(effort, data())).toBe(2);
  });

  it("is zero for a template that is only prose", () => {
    const prose = template({
      sections: [{ heading: "A", lede: "", blocks: [{ kind: "prose", text: "Hello." }] }],
    });
    expect(reportRowCount(prose, data())).toBe(0);
  });
});

describe("every built-in template composes", () => {
  it.each(BUILT_IN_TEMPLATES.map((entry) => [entry.id, entry] as const))("%s", (_id, entry) => {
    const document = composeReport(entry, data({ window: windowFor(entry.period, "", NOW) }));
    expect(document.title).not.toContain("{");
    expect(document.sections.length).toBeGreaterThan(0);
    // The whole document has to serialise, including through the escaper —
    // a chart or a table that throws only shows up here.
    expect(renderDocument(document)).toContain("</html>");
  });

  it.each(BUILT_IN_TEMPLATES.map((entry) => [entry.id, entry] as const))(
    "%s survives an empty vault",
    (_id, entry) => {
      const bare = data({
        views: [],
        allViews: [],
        entries: [],
        publications: [],
        profile: [],
        window: windowFor(entry.period, "", NOW),
      });
      const document = composeReport(entry, bare);
      // §6: every view says what it is and what to do next when there is no
      // data. An empty report must still be a document, not a blank page.
      expect(textOf(document.sections[0]!.body).length).toBeGreaterThan(0);
      expect(reportRowCount(entry, bare)).toBe(0);
    },
  );
});

describe("one study, written several ways", () => {
  // Found in Obsidian, not in a test: the picker offered `[[Example Registry]]`
  // and `Example Registry` as two studies, because a request writes a wikilink
  // and the effort log is a plain-text table. Picking either would have
  // silently dropped the other's rows from a chargeback statement.
  const spellings = ["[[Example Registry]]", "Example Registry", "[[20 Studies/Example Registry]]"];

  it.each(spellings)("scopes effort the same way for %s", (study) => {
    const scoped = data({
      study,
      entries: [
        entry({ study: "Example Registry", mins: 60 }),
        entry({ study: "[[Example Registry]]", mins: 30 }),
        entry({ study: "[[Other]]", mins: 90 }),
      ],
    });
    const text = textOf(
      composeReport(
        template({ sections: [{ heading: "H", lede: "", blocks: [{ kind: "effort", by: "study" }] }] }),
        scoped,
      ).sections[0]!.body,
    );
    // 1h 30m of the 3h logged — both spellings of the study, neither the other.
    expect(text).toContain("1.5");
    expect(text).not.toContain("2.5");
  });
});

describe("an effort roll-up adds up", () => {
  it("carries an exact duration beside the rounded hours", () => {
    // Rounded hours do not sum to a rounded total — six rows of 8.96 against a
    // total of 8.97 — and `aggregate.ts` is explicit that a roll-up whose
    // columns do not sum is one nobody can check. Found by reading a generated
    // statement, not by a test.
    const text = textOf(
      composeReport(
        template({
          sections: [{ heading: "H", lede: "", blocks: [{ kind: "effort", by: "activity" }] }],
        }),
        data({
          entries: [
            entry({ activity: "extraction", mins: 53 }),
            entry({ activity: "qc", mins: 45 }),
            entry({ activity: "analysis", mins: 145 }),
          ],
        }),
      ).sections[0]!.body,
    );
    expect(text).toContain("Time");
    // 53 + 45 + 145 = 243 minutes, and the total says exactly that.
    expect(text).toContain("4h 03m");
  });
});
