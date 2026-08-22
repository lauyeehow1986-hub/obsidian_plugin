/**
 * Bottleneck analytics: the numbers behind the charts (CLAUDE.md §7 A3).
 *
 * Every function here returns a **finished series** — title, unit, denominator,
 * empty-state sentence and all — rather than a bag of numbers the view has to
 * label. That is not decoration. §6 requires an explicit unit and a stated
 * denominator on every chart, and a rule enforced in the view is a rule that
 * holds until somebody adds a second view. Enforced here, it is testable.
 *
 * Nothing is cached: dwell depends on `now` (§5.1), so a cached chart is a
 * wrong chart.
 *
 * Pure module: no Obsidian, no Node.
 */

import { displayName } from "../report/present";
import { histogram, median, type Bucket } from "../stats/summary";
import { DAY_MS, toVaultMonth } from "../time/dates";
import { stageDwellStats } from "./dwell";
import { evaluateGatesFor } from "./gates";
import { byUrgency, rowState, type RequestView } from "./holdup";
import { allowedTargets, stageLabelOf, type WorkflowSpec } from "./workflow";

/** One bar. `emphasis` marks the part of the bar that is bad news. */
export interface Slice {
  key: string;
  label: string;
  value: number;
  /**
   * A subset of `value` drawn differently and always labelled in words —
   * "3 overdue", not a red segment on its own (§6, never colour alone).
   */
  emphasis?: { value: number; label: string };
  /** Extra context on the row, e.g. "longest 23 days". */
  note?: string;
}

export interface ChartSeries {
  id: string;
  title: string;
  /** What one unit of `value` is: "requests", "days". Rendered on the chart. */
  unit: string;
  /** The denominator, stated in words. Never left to be inferred (§6). */
  denominator: string;
  slices: Slice[];
  /** Shown instead of the chart when there is nothing to draw (§6). */
  empty: string;
  /** Spec order, not value order — do not re-sort in the view. */
  ordered: boolean;
}

export interface TrendPoint {
  key: string;
  label: string;
  /** Null when the period has no completed request to measure. */
  value: number | null;
  count: number;
}

export interface TrendSeries {
  id: string;
  title: string;
  unit: string;
  denominator: string;
  points: TrendPoint[];
  empty: string;
}

const NOTHING_YET = "No requests yet. The chart appears as soon as there are some.";

function days(ms: number | null): number | null {
  return ms === null ? null : ms / DAY_MS;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------- the queue -- */

/**
 * How many live requests sit in each stage, in the spec's order.
 *
 * Spec order, not descending count: the stages are a pipeline, and sorting them
 * by size would hide where in the pipeline the pile-up is — which is the only
 * question this chart is asked.
 */
export function queueByStage(
  views: readonly RequestView[],
  spec: WorkflowSpec | null,
): ChartSeries {
  const live = views.filter((view) => !view.metrics.completed);
  const counts = new Map<string, RequestView[]>();
  for (const view of live) {
    counts.set(view.request.stage, [...(counts.get(view.request.stage) ?? []), view]);
  }

  const ids = spec ? spec.stages.filter((s) => !s.terminal).map((s) => s.id) : [];
  for (const id of counts.keys()) if (!ids.includes(id)) ids.push(id);

  return {
    id: "queue-by-stage",
    title: "Queue by stage",
    unit: "requests",
    denominator: `${live.length} live request${live.length === 1 ? "" : "s"}`,
    ordered: true,
    empty:
      views.length === 0
        ? NOTHING_YET
        : "Every request is complete. Nothing is in the queue.",
    slices: ids.map((id) => {
      const group = counts.get(id) ?? [];
      const overdue = group.filter((view) => rowState(view) === "breached").length;
      return {
        key: id,
        label: stageLabelOf(spec, id),
        value: group.length,
        ...(overdue > 0 ? { emphasis: { value: overdue, label: `${overdue} overdue` } } : {}),
      };
    }),
  };
}

/**
 * Median dwell per stage — the systemic-bottleneck chart (§5.1).
 *
 * Completed occupancies only, for the reason `stageDwellStats` gives: a request
 * that entered a stage this morning would otherwise drag the median of that
 * stage towards zero and make the slowest step look fast.
 */
export function medianDwellByStage(
  views: readonly RequestView[],
  spec: WorkflowSpec | null,
): ChartSeries {
  // Terminal stages are excluded, not merely empty: the dwell clock stops the
  // moment a request enters one (see `stageSegments`), so "Delivered: 0 days"
  // is an artefact of that rule rather than a measurement of anything.
  const terminal = new Set(spec?.stages.filter((s) => s.terminal).map((s) => s.id) ?? []);
  const stats = stageDwellStats(views, spec).filter(
    (row) => row.closedCount > 0 && !terminal.has(row.stageId),
  );
  const measured = stats.reduce((sum, row) => sum + row.closedCount, 0);

  return {
    id: "median-dwell",
    title: "Median dwell per stage",
    unit: "days",
    denominator: `${measured} completed stage visit${measured === 1 ? "" : "s"}`,
    ordered: true,
    empty:
      views.length === 0
        ? NOTHING_YET
        : "No request has left a stage yet, so there is no completed visit to take a median of.",
    slices: stats.map((row) => ({
      key: row.stageId,
      label: stageLabelOf(spec, row.stageId),
      value: round1(days(row.medianClosedMs) ?? 0),
      note:
        row.openCount === 0
          ? `${row.closedCount} measured`
          : `${row.closedCount} measured · ${row.openCount} open now`,
    })),
  };
}

/**
 * How long the requests in the queue right now have been in their current
 * stage. The shape matters more than any single bar: a long tail is a queue
 * with forgotten work in it.
 */
const DWELL_BUCKETS: Bucket[] = [
  { label: "under 3 days", min: 0, max: 3 },
  { label: "3–7 days", min: 3, max: 7 },
  { label: "1–2 weeks", min: 7, max: 14 },
  { label: "2–4 weeks", min: 14, max: 30 },
  { label: "1–2 months", min: 30, max: 60 },
  { label: "over 2 months", min: 60, max: null },
];

export function dwellDistribution(views: readonly RequestView[]): ChartSeries {
  const values = views
    .filter((view) => !view.metrics.completed)
    .map((view) => days(view.metrics.currentDwellMs))
    .filter((value): value is number => value !== null);

  const { counts, counted } = histogram(values, DWELL_BUCKETS);

  return {
    id: "dwell-distribution",
    title: "How long requests have been where they are",
    unit: "requests",
    denominator: `${counted} live request${counted === 1 ? "" : "s"} with a readable date`,
    ordered: true,
    empty:
      views.length === 0
        ? NOTHING_YET
        : "No live request carries a date the dwell clock can read.",
    slices: counts.map((bucket) => ({
      key: bucket.label,
      label: bucket.label,
      value: bucket.count,
    })),
  };
}

/**
 * Who the holdup is with, worst first — the chase-up list as a chart.
 *
 * Truncated, because a bar chart with forty rows is a table with extra steps.
 * The cut is stated in the denominator rather than left silent.
 */
export function topBlockingParties(
  views: readonly RequestView[],
  limit = 8,
): ChartSeries {
  const byParty = new Map<string, RequestView[]>();
  for (const view of views) {
    if (view.metrics.completed) continue;
    const party = view.metrics.blockedOn;
    if (party === null || party === "") continue;
    byParty.set(party, [...(byParty.get(party) ?? []), view]);
  }

  const all = [...byParty.entries()]
    .map(([party, group]) => {
      const longest = group
        .map((view) => view.metrics.blockedForMs)
        .filter((ms): ms is number => ms !== null);
      return {
        party,
        group,
        longestMs: longest.length === 0 ? null : Math.max(...longest),
        overdue: group.filter((view) => rowState(view) === "breached").length,
      };
    })
    .sort((a, b) => b.group.length - a.group.length || (b.longestMs ?? 0) - (a.longestMs ?? 0));

  const shown = all.slice(0, limit);
  const hidden = all.length - shown.length;

  return {
    id: "blocking-parties",
    title: "Who the holdup is with",
    unit: "requests",
    denominator:
      `${byParty.size} part${byParty.size === 1 ? "y" : "ies"}` +
      (hidden > 0 ? `, top ${shown.length} shown` : ""),
    ordered: true,
    empty:
      views.length === 0
        ? NOTHING_YET
        : "Nothing is waiting on anybody. Set `blocked_on` when you move a request.",
    slices: shown.map((entry) => ({
      key: entry.party,
      // `[[Dr A Tan]]` reads as "Dr A Tan" on a chart; the link stays in the note.
      label: displayName(entry.party),
      value: entry.group.length,
      ...(entry.overdue > 0
        ? { emphasis: { value: entry.overdue, label: `${entry.overdue} overdue` } }
        : {}),
      ...(entry.longestMs === null
        ? {}
        : { note: `longest ${Math.round(entry.longestMs / DAY_MS)} days` }),
    })),
  };
}

/**
 * Live work under each hat (§7 A3).
 *
 * Counted from every request, not from the filtered board: the point of this
 * chart is to show what the hat you are *not* wearing is carrying.
 */
export function workloadByHat(
  views: readonly RequestView[],
  hats: readonly { id: string; label: string }[],
): ChartSeries {
  const live = views.filter((view) => !view.metrics.completed);
  const normalise = (hat: string) => hat.trim().toLowerCase();
  const known = new Set(hats.map((hat) => hat.id));

  const slices: Slice[] = hats.map((hat) => {
    const group = live.filter((view) => normalise(view.request.hat) === hat.id);
    const overdue = group.filter((view) => rowState(view) === "breached").length;
    return {
      key: hat.id,
      label: hat.label,
      value: group.length,
      ...(overdue > 0 ? { emphasis: { value: overdue, label: `${overdue} overdue` } } : {}),
    };
  });

  // Unfiled and misfiled work is shown, not dropped. A hat total that quietly
  // excludes six requests is worse than no total.
  const unfiled = live.filter((view) => normalise(view.request.hat) === "").length;
  if (unfiled > 0) {
    slices.push({ key: "", label: "No hat set", value: unfiled, note: "shows under every mode" });
  }
  const unknown = live.filter((view) => {
    const hat = normalise(view.request.hat);
    return hat !== "" && !known.has(hat);
  }).length;
  if (unknown > 0) {
    slices.push({
      key: "unknown",
      label: "Unrecognised hat",
      value: unknown,
      note: "probably a typo; hidden by the hat filter",
    });
  }

  return {
    id: "workload-by-hat",
    title: "Live work by hat",
    unit: "requests",
    denominator: `${live.length} live request${live.length === 1 ? "" : "s"}, every hat`,
    ordered: true,
    empty: views.length === 0 ? NOTHING_YET : "Every request is complete.",
    slices,
  };
}

/* ---------------------------------------------------------- governance -- */

export interface GovernanceRisk {
  /** Every onward move this request could make is refused by a gate. */
  blocked: RequestView[];
  /** Some onward moves are refused, but at least one is open. */
  partly: RequestView[];
  /** No gate refuses any onward move. */
  clear: number;
  /** Terminal, no spec, or nowhere declared to go — nothing to assess. */
  notAssessed: number;
  /** Which gate refuses most often: the one worth fixing first. */
  byGate: ChartSeries;
}

/**
 * Requests at governance risk, assessed by **the spec's own gates**.
 *
 * Deliberately not a second definition of "at risk". The gates in the workflow
 * spec are where governance policy lives (§5.2); a chart that re-implemented
 * "needs an IRB reference" in TypeScript would drift from them the first time
 * the spec changed, and would then be a governance instrument that quietly
 * disagreed with the governance rules.
 *
 * "Blocked" means every stage the request is *allowed* to move to is gated
 * shut. A request with one open route is not blocked, even if three other
 * routes are refused, because it can still progress.
 */
export function governanceRisk(
  views: readonly RequestView[],
  spec: WorkflowSpec | null,
  now: number,
): GovernanceRisk {
  const blocked: RequestView[] = [];
  const partly: RequestView[] = [];
  let clear = 0;
  let notAssessed = 0;
  const gateCounts = new Map<string, { label: string; count: number }>();

  for (const view of views) {
    if (spec === null || view.metrics.completed) {
      notAssessed++;
      continue;
    }
    const targets = allowedTargets(spec, view.request.stage);
    if (targets.length === 0) {
      notAssessed++;
      continue;
    }

    let open = 0;
    let shut = 0;
    // Keyed by gate, so a request refused on the same grounds by two different
    // onward moves counts once — otherwise the tallest bar would only be the
    // stage with the most declared transitions. The key is JSON rather than a
    // joined string because a gate message can contain any character at all.
    const refusedHere = new Map<string, string>();
    for (const target of targets) {
      const results = evaluateGatesFor(spec, view.request, target.id, now);
      const failing = results.filter((result) => !result.ok);
      if (failing.length === 0) {
        open++;
        continue;
      }
      shut++;
      for (const result of failing) {
        refusedHere.set(
          JSON.stringify([result.gate.to, result.gate.message]),
          `${stageLabelOf(spec, result.gate.to)}: ${result.gate.message}`,
        );
      }
    }

    for (const [key, label] of refusedHere) {
      const entry = gateCounts.get(key) ?? { label, count: 0 };
      entry.count++;
      gateCounts.set(key, entry);
    }

    if (shut === 0) clear++;
    else if (open === 0) blocked.push(view);
    else partly.push(view);
  }

  const assessed = blocked.length + partly.length + clear;
  const gates = [...gateCounts.values()].sort((a, b) => b.count - a.count);

  return {
    blocked: [...blocked].sort(byUrgency),
    partly: [...partly].sort(byUrgency),
    clear,
    notAssessed,
    byGate: {
      id: "governance-gates",
      title: "Gates currently refusing a move",
      unit: "requests",
      denominator: `${assessed} request${assessed === 1 ? "" : "s"} assessed against the spec`,
      ordered: true,
      empty:
        assessed === 0
          ? "Nothing to assess: no workflow spec, or every request is complete."
          : "No gate is refusing anything. Every request can move.",
      slices: gates.map((gate, index) => ({
        key: `${index}`,
        label: gate.label,
        value: gate.count,
      })),
    },
  };
}

/**
 * The governance headline, in one sentence.
 *
 * Here rather than in each view so the cockpit and the exported document say
 * the same thing — including "none" rather than "0 requests cannot move at
 * all", which is technically true and reads like a bug.
 */
export function describeGovernanceRisk(risk: GovernanceRisk): string {
  const parts: string[] = [];
  if (risk.blocked.length === 0 && risk.partly.length === 0) {
    parts.push("No request is held up by a gate.");
  } else {
    if (risk.blocked.length > 0) {
      parts.push(
        `${risk.blocked.length} cannot move at all — every onward stage is gated shut.`,
      );
    }
    if (risk.partly.length > 0) {
      parts.push(`${risk.partly.length} can move, but not everywhere.`);
    }
  }
  parts.push(
    `${risk.clear} clear, ${risk.notAssessed} not assessed (complete, or no route declared).`,
  );
  return parts.join(" ");
}

/* --------------------------------------------------------------- trend -- */

/** The last `months` calendar months, oldest first, including empty ones. */
function recentMonths(now: number, months: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const cursor = new Date(now);
  cursor.setDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const month = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    const key = toVaultMonth(month.getTime());
    out.push({ key, label: key.slice(2) });
  }
  return out;
}

/**
 * Median turnaround of requests completed in each of the last N months.
 *
 * Bucketed by the month a request *completed*, not the month it arrived: a
 * request that arrived in March and was delivered in July says something about
 * July's throughput, and grouping it under March would leave the current month
 * permanently understated.
 *
 * Empty months are kept as gaps rather than dropped. A line that skips the
 * months with no deliveries draws a smooth trend over a hole.
 */
export function turnaroundTrend(
  views: readonly RequestView[],
  options: { now: number; months?: number },
): TrendSeries {
  const months = options.months ?? 12;
  const completed = views.filter(
    (view) => view.metrics.completed && view.metrics.turnaroundMs !== null,
  );

  const byMonth = new Map<string, number[]>();
  for (const view of completed) {
    const last = view.request.history[view.request.history.length - 1];
    if (last === undefined) continue;
    const key = toVaultMonth(last.at);
    byMonth.set(key, [...(byMonth.get(key) ?? []), view.metrics.turnaroundMs! / DAY_MS]);
  }

  const points = recentMonths(options.now, months).map(({ key, label }) => {
    const values = byMonth.get(key) ?? [];
    const value = median(values);
    return {
      key,
      label,
      value: value === null ? null : round1(value),
      count: values.length,
    };
  });

  const measured = points.reduce((sum, point) => sum + point.count, 0);

  return {
    id: "turnaround-trend",
    title: "Turnaround trend",
    unit: "days, median",
    denominator: `${measured} request${measured === 1 ? "" : "s"} completed in the last ${months} months`,
    points,
    empty:
      completed.length === 0
        ? "Nothing has reached a terminal stage yet, so there is no turnaround to plot."
        : `Nothing was completed in the last ${months} months.`,
  };
}
