/**
 * Turning a template plus the vault's data into a document (CLAUDE.md §7 B7).
 *
 * The engine. Everything above it is data — the template says what to build,
 * this file knows how — and everything below it is the numbers, which come
 * from the same `domain/` functions the screen uses so a report and a board
 * can never disagree about the same vault.
 *
 * Output is a `ReportDocument`, which already renders two ways: as the
 * self-contained HTML of §7 A3, and (new here) as markdown. Neither renderer
 * knows anything about reports.
 *
 * Three rules hold throughout, and each has cost a design decision:
 *
 *  - **Every block states its denominator** (§6). A section that produced no
 *    rows says why, rather than printing nothing.
 *  - **The period filters what happened, not what is** — effort entries and
 *    which year's papers are listed. The queue is always as at now, and says
 *    so, because reconstructing a past queue from `history` is a claim this
 *    engine does not make.
 *  - **Nothing is presented as the official record** (§5.1). The footer
 *    `document.ts` writes says it; the blocks do not contradict it.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  compareToEstimate,
  DIMENSION_LABELS,
  filterEntries,
  formatMinutes,
  hoursOf,
  rollUp,
  totalMins,
  type EffortDimension,
} from "../effort/aggregate";
import type { TimeEntry } from "../effort/entry";
import { composeCv, type CvSectionSpec } from "../profile/cv";
import { buildPortfolio } from "../profile/portfolio";
import type { ProfileNote } from "../profile/profile";
import { formatCell, formatAggregate } from "../query/format";
import type { FieldDef, Row } from "../query/model";
import { runQuery, type QueryResult } from "../query/evaluate";
import { formatList, yearOf, type CitationFormat, type YearGroup } from "../publication/citation";
import { impactReport } from "../publication/metrics";
import type { PublicationNote } from "../publication/publication";
import {
  describeGovernanceRisk,
  governanceRisk,
  medianDwellByStage,
  queueByStage,
  topBlockingParties,
  turnaroundTrend,
  type ChartSeries,
  type TrendSeries,
} from "../request/analytics";
import { stageDwellStats } from "../request/dwell";
import { groupByBlockingParty, groupByStage, summarise, type RequestView } from "../request/holdup";
import { stageLabelOf, type WorkflowSpec } from "../request/workflow";
import { sameParty } from "../comms/party";
import { toVaultDate } from "../time/dates";
import { barChart, trendChart } from "./charts";
import { barChartSvg, trendChartSvg } from "./svg";
import type { ReportDocument, ReportSection } from "./document";
import { el, type El, type Node } from "./element";
import { count, displayName, duration } from "./present";
import { requestTable } from "./boards";
import type { PeriodKind, ReportBlock, ReportTemplate } from "./template";

/* ---------------------------------------------------------------- period -- */

export interface ReportWindow {
  kind: PeriodKind;
  /** `2026-07`, `2026`, or "" for everything. What the user picked. */
  value: string;
  /** "July 2026", "2026", "all time" — for the title and the ledes. */
  label: string;
  /** Inclusive `YYYY-MM-DD` bounds. Empty strings mean unbounded. */
  from: string;
  to: string;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;

/** Last day of a month, without leaving calendar arithmetic to epoch maths. */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The window a report covers.
 *
 * An unreadable value falls back to everything rather than to "now": a report
 * silently covering the current month when the user asked for `2026-13` would
 * carry a title saying one thing and numbers saying another.
 */
export function windowFor(kind: PeriodKind, value: string, now: number): ReportWindow {
  const trimmed = value.trim();

  if (kind === "month") {
    const match = MONTH_RE.exec(trimmed);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (month >= 1 && month <= 12) {
        const pad = String(month).padStart(2, "0");
        return {
          kind,
          value: trimmed,
          label: `${MONTH_NAMES[month - 1]} ${year}`,
          from: `${year}-${pad}-01`,
          to: `${year}-${pad}-${String(lastDay(year, month)).padStart(2, "0")}`,
        };
      }
    }
    return windowFor("month", toVaultDate(now).slice(0, 7), now);
  }

  if (kind === "year") {
    const match = YEAR_RE.exec(trimmed);
    if (match) {
      return {
        kind,
        value: trimmed,
        label: match[1]!,
        from: `${match[1]}-01-01`,
        to: `${match[1]}-12-31`,
      };
    }
    return windowFor("year", toVaultDate(now).slice(0, 4), now);
  }

  return { kind: "all", value: "", label: "all time", from: "", to: "" };
}

/* ------------------------------------------------------------------ data -- */

export interface ReportData {
  /** Requests, already narrowed to the study when the report names one. */
  views: readonly RequestView[];
  /** Unnarrowed, for charts that are about what everything else is carrying. */
  allViews: readonly RequestView[];
  spec: WorkflowSpec | null;
  /** Every time entry the vault holds. Narrowing is this module's job. */
  entries: readonly TimeEntry[];
  publications: readonly PublicationNote[];
  profile: readonly ProfileNote[];
  /** For `query` blocks — the same rows the Explore board runs over. */
  rows: readonly Row[];
  fields: readonly FieldDef[];
  citationFormat: CitationFormat;
  window: ReportWindow;
  /** The study the report is about, as written, or "". */
  study: string;
  now: number;
  /** Local stamp for the footer, e.g. "2026-08-24 09:41". */
  generatedAt: string;
  /** "Head of SCDB work only", or "" when nothing is filtered out. */
  scope: string;
  /**
   * Which chart renderer to use.
   *
   * "html" hangs the drawing on classes the export's stylesheet fills in;
   * "svg" draws with presentation attributes because a markdown note has no
   * stylesheet at all. Chosen here rather than in the renderer so the document
   * a caller holds is already right for where it is going — a tree that has to
   * be reinterpreted downstream is a tree that gets reinterpreted wrongly.
   */
  charts: "html" | "svg";
}

function bar(series: ChartSeries, data: ReportData): El {
  return data.charts === "svg" ? barChartSvg(series) : barChart(series);
}

function trend(series: TrendSeries, data: ReportData): El {
  return data.charts === "svg" ? trendChartSvg(series) : trendChart(series);
}

/**
 * Time entries inside the window, and for the study when there is one.
 *
 * The study is matched with `sameParty`, not with `filterEntries`' own
 * comparison, because the effort log is a plain-text table while a request
 * writes `[[Example Registry]]`. Both spell one study, and a chargeback
 * statement that dropped half the hours over a pair of brackets would be worse
 * than no statement.
 */
function scopedEntries(data: ReportData): TimeEntry[] {
  const inWindow = filterEntries(data.entries, {
    ...(data.window.from === "" ? {} : { from: data.window.from }),
    ...(data.window.to === "" ? {} : { to: data.window.to }),
  });
  return data.study === ""
    ? inWindow
    : inWindow.filter((entry) => sameParty(entry.study, data.study));
}

/** Publications whose year falls in the window. All of them when it is open. */
function scopedPublications(data: ReportData): PublicationNote[] {
  if (data.window.kind === "all") return [...data.publications];
  const wanted = Number(data.window.from.slice(0, 4));
  return data.publications.filter((publication) => yearOf(publication).year === wanted);
}

/* --------------------------------------------------------------- helpers -- */

function empty(message: string): El {
  return el("p", { class: "scdb-empty" }, message);
}

function table(headers: readonly { label: string; num?: boolean }[], rows: Node[][]): El {
  return el(
    "table",
    {},
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        headers.map((header) => el("th", header.num === true ? { class: "num" } : {}, header.label)),
      ),
    ),
    el(
      "tbody",
      {},
      rows.map((cells) =>
        el(
          "tr",
          {},
          cells.map((cell, index) =>
            el("td", headers[index]?.num === true ? { class: "num" } : {}, cell),
          ),
        ),
      ),
    ),
  );
}

/** Substitute `{period}` and `{study}` in a template's title or lede. */
export function fillPlaceholders(text: string, data: ReportData): string {
  return text
    .replace(/\{period\}/g, data.window.label)
    .replace(/\{study\}/g, data.study === "" ? "every study" : displayName(data.study));
}

/* ---------------------------------------------------------------- blocks -- */

function requestQueueBlock(data: ReportData): Node[] {
  const live = data.views.filter((view) => !view.metrics.completed);
  if (live.length === 0) {
    return [empty("Nothing is in the queue.")];
  }

  const groups = groupByStage(live, data.spec).filter((group) => group.views.length > 0);
  return [
    bar(queueByStage(live, data.spec), data),
    ...groups.flatMap((group) => [
      el(
        "p",
        { class: "lede" },
        `${group.label} — ${count(group.views.length, "request")}` +
          (group.longestDwellMs === null ? "" : ` · longest ${duration(group.longestDwellMs)}`) +
          (group.breachedCount > 0 ? ` · ${group.breachedCount} overdue` : ""),
      ),
      requestTable(group.views, data.spec),
    ]),
  ];
}

function turnaroundBlock(data: ReportData): Node[] {
  const stats = stageDwellStats(data.views, data.spec).filter(
    (row) => row.closedCount > 0 || row.openCount > 0,
  );

  return [
    trend(turnaroundTrend(data.views, { now: data.now }), data),
    bar(medianDwellByStage(data.views, data.spec), data),
    stats.length === 0
      ? empty("No stage has been left yet, so there is nothing to average.")
      : table(
          [
            { label: "Stage" },
            { label: "Median", num: true },
            { label: "Completed", num: true },
            { label: "Open now", num: true },
            { label: "Longest open", num: true },
          ],
          stats.map((row) => [
            stageLabelOf(data.spec, row.stageId),
            duration(row.medianClosedMs),
            String(row.closedCount),
            String(row.openCount),
            duration(row.longestOpenMs),
          ]),
        ),
  ];
}

function bottlenecksBlock(data: ReportData): Node[] {
  const live = data.views.filter((view) => !view.metrics.completed);
  const parties = groupByBlockingParty(live);
  const risk = governanceRisk(live, data.spec, data.now);

  return [
    bar(topBlockingParties(live), data),
    parties.length === 0
      ? empty("Nothing is waiting on anybody.")
      : table(
          [
            { label: "Waiting on" },
            { label: "Requests", num: true },
            { label: "Longest wait", num: true },
            { label: "Overdue", num: true },
          ],
          parties.map((group) => [
            displayName(group.party),
            String(group.views.length),
            duration(group.longestBlockedMs),
            group.breachedCount === 0 ? "—" : String(group.breachedCount),
          ]),
        ),
    el("p", { class: "lede" }, describeGovernanceRisk(risk)),
    bar(risk.byGate, data),
  ];
}

/** A roll-up as a chart series, so effort draws with the same rules as everything else. */
function effortSeries(
  buckets: ReturnType<typeof rollUp>,
  dimension: EffortDimension,
  label: string,
): ChartSeries {
  return {
    id: `effort-${dimension}`,
    title: `Effort by ${DIMENSION_LABELS[dimension].toLowerCase()}`,
    unit: "hours",
    denominator: label,
    slices: buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      value: hoursOf(bucket.mins),
      note: `${bucket.count} entr${bucket.count === 1 ? "y" : "ies"}`,
    })),
    empty: "No time was logged in this period.",
    // `rollUp` has already ordered these — largest first, or chronologically
    // for a date dimension — and re-sorting would put January after December.
    ordered: true,
  };
}

function effortBlock(data: ReportData, dimension: EffortDimension): Node[] {
  const entries = scopedEntries(data);
  const total = totalMins(entries);
  if (entries.length === 0) {
    return [
      empty(
        `No time is logged against ${data.study === "" ? "anything" : displayName(data.study)} in ${data.window.label}.`,
      ),
    ];
  }

  const buckets = rollUp(entries, dimension);
  const denominator = `${formatMinutes(total)} across ${count(entries.length, "entry", "entries")} · ${data.window.label}`;

  return [
    bar(effortSeries(buckets, dimension, denominator), data),
    // Time and hours both, from the same minutes. Hours are what a chargeback
    // line is quoted in, but rounded hours do not add up to a rounded total —
    // 8.97 against a column summing to 8.96 — and `aggregate.ts` is explicit
    // that a roll-up whose columns do not sum is one nobody can check. The
    // exact duration beside it is the column that does sum, and §6 asks for
    // durations to be human anyway.
    table(
      [
        { label: DIMENSION_LABELS[dimension] },
        { label: "Entries", num: true },
        { label: "Time", num: true },
        { label: "Hours", num: true },
        { label: "Share", num: true },
      ],
      [
        ...buckets.map((bucket) => [
          bucket.label,
          String(bucket.count),
          formatMinutes(bucket.mins),
          String(hoursOf(bucket.mins)),
          total === 0 ? "—" : `${Math.round((bucket.mins / total) * 100)}%`,
        ]),
        // A total row, because a chargeback line is read off the bottom of the
        // table and adding the column up by hand is where the argument starts.
        ["Total", String(entries.length), formatMinutes(total), String(hoursOf(total)), "100%"],
      ],
    ),
  ];
}

function estimateBlock(data: ReportData): Node[] {
  // All time ever logged, not the window's: an estimate is for the whole piece
  // of work, and comparing it to one month of effort would flatter every
  // request that ran over in the month before.
  const rows = data.views
    .map((view) => {
      const actual = totalMins(
        filterEntries(data.entries, { ref: view.request.id }).filter(
          (entry) => entry.ref !== "",
        ),
      );
      return {
        view,
        comparison: compareToEstimate(view.request.effortEstimateHours, actual),
      };
    })
    .filter((row) => row.comparison.estimateMins !== null || row.comparison.actualMins > 0)
    .sort((a, b) => (b.comparison.overBy ?? -Infinity) - (a.comparison.overBy ?? -Infinity));

  if (rows.length === 0) {
    return [
      empty("No request in scope carries an effort estimate, and none has time logged against it."),
    ];
  }

  return [
    table(
      [
        { label: "Request" },
        { label: "Title" },
        { label: "Estimated", num: true },
        { label: "Actual", num: true },
        { label: "Difference", num: true },
      ],
      rows.map(({ view, comparison }) => [
        view.request.id || view.request.uid.slice(0, 8),
        view.request.title || "(untitled)",
        comparison.estimateMins === null ? "—" : formatMinutes(comparison.estimateMins),
        formatMinutes(comparison.actualMins),
        comparison.overBy === null
          ? "—"
          : comparison.overBy > 0
            ? `+${formatMinutes(comparison.overBy)}`
            : `−${formatMinutes(-comparison.overBy)}`,
      ]),
    ),
  ];
}

/** A year of citations as a numbered list, the way a publication list is read. */
function citationList(groups: readonly YearGroup[]): Node[] {
  return groups.flatMap((group) => [
    el("h3", {}, group.year === null ? "Undated" : String(group.year)),
    el(
      "ol",
      {},
      group.citations.map((citation) => el("li", {}, citation.text)),
    ),
  ]);
}

function publicationsBlock(
  data: ReportData,
  block: Extract<ReportBlock, { kind: "publications" }>,
): Node[] {
  const groups = formatList(scopedPublications(data), {
    format: data.citationFormat,
    scdbOnly: block.scdbOnly,
    ...(block.stages === null ? {} : { stages: block.stages }),
  });
  const total = groups.reduce((sum, group) => sum + group.citations.length, 0);

  if (total === 0) {
    return [
      empty(
        `No manuscript is accepted, in press or published${block.scdbOnly ? " with this facility's support" : ""} in ${data.window.label}.`,
      ),
    ];
  }

  return [
    el(
      "p",
      { class: "lede" },
      `${count(total, "reference")}, ${data.citationFormat === "apa" ? "APA" : "Vancouver"} format` +
        (block.scdbOnly ? ", facility-supported only" : "") +
        ".",
    ),
    ...citationList(groups),
  ];
}

function publicationMetricsBlock(data: ReportData): Node[] {
  const scoped = scopedPublications(data);
  if (scoped.length === 0) {
    return [empty(`No manuscript falls in ${data.window.label}.`)];
  }

  const impact = impactReport(scoped);
  const stageRows = impact.byStage.counts.map((row) => [
    row.label,
    String(row.count),
  ]);

  return [
    el(
      "p",
      { class: "lede" },
      `${count(impact.total, "manuscript")} · ${impact.scdbSupported} facility-supported, ` +
        `${impact.scdbPublished} of those in print. ` +
        (impact.decision.days === null
          ? "No manuscript has a first decision recorded, so there is no median to give."
          : `Median time to first decision ${impact.decision.days} days, over ${count(impact.decision.measured, "manuscript")}` +
            (impact.decision.awaiting === 0
              ? "."
              : `, with ${impact.decision.awaiting} still awaiting one.`)),
    ),
    table([{ label: "Stage" }, { label: "Manuscripts", num: true }], stageRows),
    impact.journals.length === 0
      ? empty("No journal has been recorded against a manuscript that landed.")
      : table(
          // Rejections beside acceptances, as `journalLandings` computes them:
          // "we send here a lot and it never takes us" is the actionable half.
          [
            { label: "Journal" },
            { label: "Landed", num: true },
            { label: "Rejected", num: true },
            { label: "Facility-supported", num: true },
          ],
          impact.journals.map((journal) => [
            journal.journal,
            String(journal.landed),
            journal.rejected === 0 ? "—" : String(journal.rejected),
            String(journal.scdbSupported),
          ]),
        ),
    impact.resubmissions.length === 0
      ? null
      : el(
          "p",
          { class: "lede" },
          `${count(impact.resubmissions.length, "manuscript")} went to more than one journal.`,
        ),
  ];
}

function cvBlock(data: ReportData, layout: readonly CvSectionSpec[] | null): Node[] {
  const cv = composeCv({
    profile: data.profile,
    publications: data.publications,
    format: data.citationFormat,
    ...(layout === null ? {} : { layout }),
  });

  if (cv.total === 0) {
    return [
      empty(
        "Nothing to build a CV from yet. Add notes to 84 Profile/ — one per grant, role, course, trainee, talk or award — and publications to 85 Publications/.",
      ),
    ];
  }

  const nodes: Node[] = [];
  for (const section of cv.sections) {
    nodes.push(el("h2", {}, section.heading));
    if (section.lede !== "") nodes.push(el("p", { class: "lede" }, section.lede));
    if (section.years.length > 0) {
      nodes.push(...citationList(section.years));
      continue;
    }
    nodes.push(
      table(
        [{ label: "When" }, { label: "Item" }],
        section.entries.map((entry) => [entry.when === "" ? "—" : entry.when, entry.text]),
      ),
    );
  }

  if (cv.uncertainAuthors.length > 0) {
    // Named rather than counted: a CV is checked line by line before it is
    // sent, and "check 3 names" without saying which is not a check.
    nodes.push(
      el(
        "p",
        { class: "lede" },
        `Check how these author names were split into surname and initials: ${cv.uncertainAuthors.join(", ")}.`,
      ),
    );
  }

  return nodes;
}

function portfolioBlock(data: ReportData): Node[] {
  const portfolio = buildPortfolio({
    publications: data.publications,
    profile: data.profile,
    views: data.views,
    entries: scopedEntries(data),
    periodLabel: data.window.label,
    now: data.now,
  });

  if (portfolio.empty) {
    return [
      empty(
        "Nothing to profile yet. This page is built from 85 Publications/, 84 Profile/ and the request queue.",
      ),
    ];
  }

  const nodes: Node[] = [
    // Named columns, not a blank header band. "Denominator" is the honest name
    // for the third one and teaches §6's rule to the reader: no number here
    // stands without the thing it is a number of.
    table(
      [{ label: "Measure" }, { label: "Value", num: true }, { label: "Denominator" }],
      portfolio.headlines.map((headline) => [headline.label, headline.value, headline.note]),
    ),
  ];

  if (portfolio.themes.length > 0) {
    nodes.push(el("h3", {}, "Themes"));
    nodes.push(
      el(
        "p",
        { class: "lede" },
        "Grouped by the studies the notes link to, not by inferred keywords — every row is something the vault actually asserts.",
      ),
    );
    nodes.push(
      table(
        [
          { label: "Study" },
          { label: "Papers", num: true },
          { label: "Facility-supported", num: true },
          { label: "Requests", num: true },
          { label: "Grants", num: true },
        ],
        portfolio.themes.map((theme) => [
          theme.study,
          String(theme.publications),
          String(theme.scdbSupported),
          String(theme.requests),
          String(theme.grants),
        ]),
      ),
    );
  }

  if (portfolio.collaborators.length > 0) {
    nodes.push(el("h3", {}, "Collaborations"));
    nodes.push(
      el(
        "p",
        { class: "lede" },
        "Everyone named as an author on a tracked manuscript, most frequent first — including you, because the vault records your author position but not your name.",
      ),
    );
    nodes.push(
      table(
        [{ label: "Author" }, { label: "Manuscripts", num: true }],
        portfolio.collaborators.map((person) => [person.name, String(person.publications)]),
      ),
    );
  }

  return nodes;
}

function queryBlock(
  data: ReportData,
  block: Extract<ReportBlock, { kind: "query" }>,
): Node[] {
  const result: QueryResult = runQuery(data.rows, block.query, data.fields, { now: data.now });
  const nodes: Node[] = [];

  if (block.title !== "") nodes.push(el("h3", {}, block.title));
  if (result.problems.length > 0) {
    nodes.push(el("p", { class: "lede" }, result.problems.join(" ")));
  }
  if (result.matched === 0) {
    nodes.push(empty("No note matches this query."));
    return nodes;
  }

  for (const group of result.groups) {
    if (group.label !== "") nodes.push(el("p", { class: "lede" }, group.label));
    nodes.push(
      table(
        result.columns.map((column) => ({
          label: column.label,
          num: column.kind === "number" || column.kind === "duration",
        })),
        group.rows.map((row) =>
          result.columns.map((column) => formatCell(row.fields[column.id], column.kind, data.now)),
        ),
      ),
    );
    if (group.aggregates.length > 0) {
      nodes.push(
        el(
          "p",
          { class: "lede" },
          group.aggregates
            .map((aggregate) => `${aggregate.label}: ${formatAggregate(aggregate)}`)
            .join(" · "),
        ),
      );
    }
  }

  if (result.truncated) {
    nodes.push(
      el(
        "p",
        { class: "lede" },
        `Showing ${result.returned} of ${result.matched} matching notes — the query sets a limit.`,
      ),
    );
  }
  return nodes;
}

function composeBlock(block: ReportBlock, data: ReportData): Node[] {
  switch (block.kind) {
    case "prose":
      // Split on blank lines so a `|` block in YAML becomes paragraphs rather
      // than one run-on. Never parsed as markdown: this is vault-derived text
      // and §8 keeps it out of anything that could interpret markup.
      return fillPlaceholders(block.text, data)
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "")
        .map((paragraph) => el("p", {}, paragraph));
    case "request-queue":
      return requestQueueBlock(data);
    case "turnaround":
      return turnaroundBlock(data);
    case "bottlenecks":
      return bottlenecksBlock(data);
    case "effort":
      return effortBlock(data, block.by);
    case "estimate-vs-actual":
      return estimateBlock(data);
    case "publications":
      return publicationsBlock(data, block);
    case "publication-metrics":
      return publicationMetricsBlock(data);
    case "cv":
      return cvBlock(data, block.layout);
    case "portfolio":
      return portfolioBlock(data);
    case "query":
      return queryBlock(data, block);
  }
}

/* -------------------------------------------------------------- the whole -- */

/**
 * The one-line state under the title.
 *
 * Different per template, because "9 live requests · 2 overdue" is the right
 * sentence for a facility report and a meaningless one on a CV.
 */
function subtitleFor(template: ReportTemplate, data: ReportData): string {
  const uses = (kind: ReportBlock["kind"]) =>
    template.sections.some((section) => section.blocks.some((block) => block.kind === kind));

  const parts: string[] = [];
  if (uses("request-queue") || uses("turnaround") || uses("bottlenecks")) {
    const summary = summarise(data.views);
    parts.push(
      `${count(summary.live, "live request")} · ${summary.breached} overdue · ${summary.blocked} waiting on someone`,
    );
  }
  if (uses("effort") || uses("estimate-vs-actual")) {
    const entries = scopedEntries(data);
    parts.push(`${formatMinutes(totalMins(entries))} logged in ${data.window.label}`);
  }
  if (uses("publications") || uses("publication-metrics") || uses("cv")) {
    const scoped = uses("cv") ? data.publications : scopedPublications(data);
    parts.push(count(scoped.length, "manuscript"));
  }
  if (uses("cv") || uses("portfolio")) {
    parts.push(count(data.profile.length, "profile note"));
  }
  return parts.length === 0 ? data.window.label : parts.join(" · ");
}

export function composeReport(template: ReportTemplate, data: ReportData): ReportDocument {
  const sections: ReportSection[] = template.sections.map((section) => ({
    heading: fillPlaceholders(section.heading, data),
    ...(section.lede === "" ? {} : { lede: fillPlaceholders(section.lede, data) }),
    body: el("div", {}, section.blocks.flatMap((block) => composeBlock(block, data))),
  }));

  return {
    title: fillPlaceholders(template.title, data),
    subtitle: subtitleFor(template, data),
    generatedAt: data.generatedAt,
    ...(data.scope === "" ? {} : { scope: data.scope }),
    sections,
  };
}

/**
 * How many rows the report is about.
 *
 * Named in the confirmation before anything is written and in the ledger
 * afterwards (§7 A3), so it counts the things a reader would count — requests,
 * time entries, references, CV lines — and not the HTML elements.
 */
export function reportRowCount(template: ReportTemplate, data: ReportData): number {
  let rows = 0;
  // Keyed on the *data* a block draws on, not on the block kind. A monthly
  // report showing the queue, the turnaround and the bottlenecks is about one
  // set of requests; counting it three times would put a number in the ledger
  // that nothing in the file adds up to.
  const counted = new Set<string>();
  const once = (source: string, howMany: () => number) => {
    if (counted.has(source)) return;
    counted.add(source);
    rows += howMany();
  };

  for (const section of template.sections) {
    for (const block of section.blocks) {
      switch (block.kind) {
        case "request-queue":
        case "turnaround":
        case "bottlenecks":
        case "estimate-vs-actual":
          once("requests", () => data.views.length);
          break;
        case "effort":
          once("effort", () => scopedEntries(data).length);
          break;
        case "publications":
        case "publication-metrics":
          once("publications", () => scopedPublications(data).length);
          break;
        case "cv":
          once("cv", () =>
            composeCv({
              profile: data.profile,
              publications: data.publications,
              format: data.citationFormat,
              ...(block.layout === null ? {} : { layout: block.layout }),
            }).total,
          );
          break;
        case "portfolio":
          once("portfolio", () => data.publications.length + data.profile.length);
          break;
        case "query":
          // Every query is its own question, so each one counts.
          rows += runQuery(data.rows, block.query, data.fields, { now: data.now }).returned;
          break;
        case "prose":
          break;
      }
    }
  }
  return rows;
}
