/**
 * Turning a cockpit board into a static document (CLAUDE.md §7 A3).
 *
 * A snapshot, not a clone. The interactive board is cards you click; the export
 * is a table somebody reads, prints and files, and forcing one into the shape
 * of the other would produce a worse version of both. What is shared is the
 * part that must not drift — the **numbers**, which come from the same
 * `domain/request` functions the screen uses, and the **charts**, which are the
 * same element trees rendered through a different adapter.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  describeGovernanceRisk,
  dwellDistribution,
  governanceRisk,
  medianDwellByStage,
  queueByStage,
  topBlockingParties,
  turnaroundTrend,
  workloadByHat,
} from "../request/analytics";
import { stageDwellStats } from "../request/dwell";
import {
  ageing,
  groupByBlockingParty,
  groupByStage,
  rowState,
  summarise,
  type RequestView,
} from "../request/holdup";
import { stageLabelOf, type WorkflowSpec } from "../request/workflow";
import { barChart, trendChart } from "./charts";
import { el, type El } from "./element";
import type { ReportDocument, ReportSection } from "./document";
import { count, displayName, duration, presentState } from "./present";

export type BoardId = "queue" | "holdup" | "ageing" | "analytics" | "health";

export interface BoardContext {
  views: readonly RequestView[];
  /** Unfiltered, for charts that are about what the *other* hats are carrying. */
  allViews: readonly RequestView[];
  spec: WorkflowSpec | null;
  hats: readonly { id: string; label: string }[];
  now: number;
  generatedAt: string;
  /** "Head of SCDB work only", or empty when nothing is filtered out. */
  scope: string;
}

/** The columns every request table shares — dwell, age and bounce travel together (§5.1). */
const COLUMNS = [
  { key: "id", label: "Request", num: false },
  { key: "title", label: "Title", num: false },
  { key: "stage", label: "Stage", num: false },
  { key: "state", label: "State", num: false },
  { key: "dwell", label: "Here", num: true },
  { key: "age", label: "Age", num: true },
  { key: "bounces", label: "Bounces", num: true },
  { key: "blocked", label: "Waiting on", num: false },
] as const;

function requestRow(view: RequestView, spec: WorkflowSpec | null): El {
  const { request, metrics } = view;
  const state = presentState(rowState(view));
  return el(
    "tr",
    {},
    el("td", {}, request.id || request.uid.slice(0, 8)),
    el("td", {}, request.title || "(untitled)"),
    el("td", {}, stageLabelOf(spec, request.stage)),
    // Glyph and word, never a colour on its own (§6) — and this file may well
    // be printed in black and white.
    el(
      "td",
      { class: state.label === "Overdue" ? "state state--overdue" : "state" },
      `${state.glyph} ${state.label}`,
    ),
    el("td", { class: "num" }, duration(metrics.currentDwellMs)),
    el("td", { class: "num" }, duration(metrics.totalAgeMs)),
    el("td", { class: "num" }, metrics.bounceCount === 0 ? "—" : String(metrics.bounceCount)),
    el("td", {}, displayName(metrics.blockedOn)),
  );
}

/**
 * The request table, shared with B7's report engine.
 *
 * Exported rather than reimplemented there: the columns are a decision from
 * §5.1 — current dwell, cumulative age and bounce count always travel together
 * — and a report showing dwell without bounces would quietly answer the
 * question wrongly for a request that has been sent back twice.
 */
export function requestTable(views: readonly RequestView[], spec: WorkflowSpec | null): El {
  return el(
    "table",
    {},
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        COLUMNS.map((column) => el("th", column.num ? { class: "num" } : {}, column.label)),
      ),
    ),
    el("tbody", {}, views.map((view) => requestRow(view, spec))),
  );
}

function empty(message: string): El {
  return el("p", { class: "scdb-empty" }, message);
}

/** The one-line state of the queue, the same sentence the cockpit header shows. */
function subtitle(views: readonly RequestView[]): string {
  const s = summarise(views);
  return (
    `${count(s.live, "live request")} · ${s.breached} overdue · ${s.atRisk} at risk · ` +
    `${s.blocked} waiting on someone` +
    (s.bounced > 0 ? ` · ${s.bounced} bounced` : "") +
    (s.completed > 0 ? ` · ${s.completed} complete` : "")
  );
}

function queueSections(context: BoardContext): ReportSection[] {
  const groups = groupByStage(context.views, context.spec).filter(
    (group) => group.views.length > 0,
  );
  if (groups.length === 0) {
    return [{ heading: "Queue", body: empty("Nothing is in the queue.") }];
  }
  return groups.map((group) => ({
    heading: group.label,
    lede:
      `${count(group.views.length, "request")}` +
      (group.longestDwellMs === null ? "" : ` · longest ${duration(group.longestDwellMs)}`) +
      (group.breachedCount > 0 ? ` · ${group.breachedCount} overdue` : ""),
    body: requestTable(group.views, context.spec),
  }));
}

function holdupSections(context: BoardContext): ReportSection[] {
  const groups = groupByBlockingParty(context.views);
  if (groups.length === 0) {
    return [
      {
        heading: "Holdup",
        body: empty("Nothing is waiting on anybody."),
      },
    ];
  }
  return groups.map((group) => ({
    heading: displayName(group.party),
    lede:
      `${count(group.views.length, "request")}` +
      (group.longestBlockedMs === null ? "" : ` · longest ${duration(group.longestBlockedMs)}`) +
      (group.breachedCount > 0 ? ` · ${group.breachedCount} overdue` : ""),
    body: requestTable(group.views, context.spec),
  }));
}

function ageingSections(context: BoardContext): ReportSection[] {
  const rows = ageing(context.views);
  return [
    {
      heading: "Overdue and at risk",
      lede: "Worst first. Requests that are on track are not listed.",
      body:
        rows.length === 0
          ? empty("Nothing is overdue or close to it.")
          : requestTable(rows, context.spec),
    },
  ];
}

function analyticsSections(context: BoardContext): ReportSection[] {
  const risk = governanceRisk(context.views, context.spec, context.now);
  return [
    {
      heading: "Where the work is",
      body: el(
        "div",
        { class: "chartgrid" },
        barChart(queueByStage(context.views, context.spec)),
        barChart(medianDwellByStage(context.views, context.spec)),
        barChart(dwellDistribution(context.views)),
        barChart(topBlockingParties(context.views)),
        barChart(workloadByHat(context.allViews, context.hats)),
        trendChart(turnaroundTrend(context.views, { now: context.now })),
      ),
    },
    {
      heading: "Governance",
      lede: `${describeGovernanceRisk(risk)} Assessed against the workflow spec's own gates.`,
      body: el(
        "div",
        {},
        barChart(risk.byGate),
        risk.blocked.length === 0 ? null : requestTable(risk.blocked, context.spec),
      ),
    },
  ];
}

function healthSections(context: BoardContext): ReportSection[] {
  const stats = stageDwellStats(context.views, context.spec).filter(
    (row) => row.closedCount > 0 || row.openCount > 0,
  );
  const problems = context.views.filter((view) => view.metrics.problems.length > 0);

  return [
    {
      heading: "Median dwell per stage",
      lede: "Completed occupancies only — an open visit would drag the median towards zero.",
      body:
        stats.length === 0
          ? empty("No stage has been left yet, so there is nothing to average.")
          : el(
              "table",
              {},
              el(
                "thead",
                {},
                el(
                  "tr",
                  {},
                  el("th", {}, "Stage"),
                  el("th", { class: "num" }, "Median"),
                  el("th", { class: "num" }, "Completed"),
                  el("th", { class: "num" }, "Open now"),
                  el("th", { class: "num" }, "Longest open"),
                ),
              ),
              el(
                "tbody",
                {},
                stats.map((row) =>
                  el(
                    "tr",
                    {},
                    el("td", {}, stageLabelOf(context.spec, row.stageId)),
                    el("td", { class: "num" }, duration(row.medianClosedMs)),
                    el("td", { class: "num" }, String(row.closedCount)),
                    el("td", { class: "num" }, String(row.openCount)),
                    el("td", { class: "num" }, duration(row.longestOpenMs)),
                  ),
                ),
              ),
            ),
    },
    {
      heading: "Notes that need attention",
      body:
        problems.length === 0
          ? empty("Every request note reads cleanly.")
          : el(
              "ul",
              {},
              problems.map((view) =>
                el(
                  "li",
                  {},
                  `${view.request.id || view.request.uid}: ${view.metrics.problems.join(" ")}`,
                ),
              ),
            ),
    },
  ];
}

const BUILDERS: Record<BoardId, { title: string; sections: (c: BoardContext) => ReportSection[] }> =
  {
    queue: { title: "Request queue", sections: queueSections },
    holdup: { title: "Who the holdup is with", sections: holdupSections },
    ageing: { title: "Overdue and at risk", sections: ageingSections },
    analytics: { title: "Queue analytics", sections: analyticsSections },
    health: { title: "Queue health", sections: healthSections },
  };

export function boardTitle(board: BoardId): string {
  return BUILDERS[board].title;
}

export function buildBoardDocument(board: BoardId, context: BoardContext): ReportDocument {
  return {
    title: BUILDERS[board].title,
    subtitle: subtitle(context.views),
    generatedAt: context.generatedAt,
    ...(context.scope === "" ? {} : { scope: context.scope }),
    sections: BUILDERS[board].sections(context),
  };
}

/**
 * How many rows the export will contain.
 *
 * Shown in the confirmation before anything is written and recorded in the
 * ledger afterwards (§7 A3), so it counts the requests the document is about
 * rather than the HTML elements it happens to contain.
 */
export function boardRowCount(board: BoardId, context: BoardContext): number {
  if (board === "ageing") return ageing(context.views).length;
  if (board === "holdup") {
    return groupByBlockingParty(context.views).reduce(
      (total, group) => total + group.views.length,
      0,
    );
  }
  return context.views.length;
}
