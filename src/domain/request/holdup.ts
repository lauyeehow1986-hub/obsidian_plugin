/**
 * The three holdup views (CLAUDE.md §7 A1): by stage, by blocking person, and
 * aged/breaching.
 *
 * Grouping lives here rather than in the view because these are the questions
 * the tracker exists to answer, and questions worth testing:
 *
 *  - Where is each request right now, and how long has it sat there?
 *  - Who is the holdup — grouped, so one chase-up email covers five requests.
 *  - Which requests will breach SLA, and which already have?
 *
 * Pure module: no Obsidian, no Node.
 */

import type { RequestMetrics, SlaState } from "./dwell";
import { worstSlaState } from "./dwell";
import type { RequestNote } from "./request";
import type { WorkflowSpec } from "./workflow";

/** A request paired with its freshly computed metrics. */
export interface RequestView {
  request: RequestNote;
  metrics: RequestMetrics;
}

/** The single SLA badge for a row: the worse of stage target and due date. */
export function rowState(view: RequestView): SlaState {
  return worstSlaState(view.metrics.stageSla.state, view.metrics.dueSla.state);
}

const STATE_RANK: Record<SlaState, number> = {
  breached: 0,
  "at-risk": 1,
  "on-track": 2,
  "no-target": 3,
};

/**
 * Worst first, then oldest first. This is the order every board uses, so the
 * thing most likely to embarrass you is at the top of the screen.
 */
export function byUrgency(a: RequestView, b: RequestView): number {
  const rank = STATE_RANK[rowState(a)] - STATE_RANK[rowState(b)];
  if (rank !== 0) return rank;
  return (b.metrics.totalAgeMs ?? 0) - (a.metrics.totalAgeMs ?? 0);
}

export interface StageGroup {
  stageId: string;
  label: string;
  views: RequestView[];
  breachedCount: number;
  /** Longest current dwell in this stage. */
  longestDwellMs: number | null;
}

/**
 * Group by current stage, in the spec's declared order — including stages with
 * nothing in them, because an empty column is information (§6, empty states).
 * Completed requests are left out: a delivered request is not in the queue.
 */
export function groupByStage(
  views: readonly RequestView[],
  spec: WorkflowSpec | null,
  options: { includeCompleted?: boolean } = {},
): StageGroup[] {
  const includeCompleted = options.includeCompleted ?? false;
  const live = views.filter((v) => includeCompleted || !v.metrics.completed);

  const byStage = new Map<string, RequestView[]>();
  for (const view of live) {
    const key = view.request.stage;
    byStage.set(key, [...(byStage.get(key) ?? []), view]);
  }

  const ordered = spec ? spec.stages.map((s) => ({ id: s.id, label: s.label })) : [];
  for (const key of byStage.keys()) {
    if (!ordered.some((s) => s.id === key)) ordered.push({ id: key, label: key });
  }

  return ordered.map(({ id, label }) => {
    const group = (byStage.get(id) ?? []).sort(byUrgency);
    const dwells = group
      .map((v) => v.metrics.currentDwellMs)
      .filter((ms): ms is number => ms !== null);
    return {
      stageId: id,
      label,
      views: group,
      breachedCount: group.filter((v) => rowState(v) === "breached").length,
      longestDwellMs: dwells.length === 0 ? null : Math.max(...dwells),
    };
  });
}

export interface PartyGroup {
  /** The wikilink or name exactly as written in `blocked_on`. */
  party: string;
  views: RequestView[];
  /** The longest-running holdup with this party — what the chase-up email leads with. */
  longestBlockedMs: number | null;
  breachedCount: number;
}

/**
 * Group by who the holdup is with, longest-suffering party first.
 *
 * This is the view that turns five separate nags into one email, which is the
 * whole reason `blocked_on` is a first-class field rather than a note in the
 * body.
 */
export function groupByBlockingParty(views: readonly RequestView[]): PartyGroup[] {
  const byParty = new Map<string, RequestView[]>();
  for (const view of views) {
    if (view.metrics.completed) continue;
    const party = view.metrics.blockedOn;
    if (party === null || party === "") continue;
    byParty.set(party, [...(byParty.get(party) ?? []), view]);
  }

  return [...byParty.entries()]
    .map(([party, group]) => {
      const blocked = group
        .map((v) => v.metrics.blockedForMs)
        .filter((ms): ms is number => ms !== null);
      return {
        party,
        views: [...group].sort(byUrgency),
        longestBlockedMs: blocked.length === 0 ? null : Math.max(...blocked),
        breachedCount: group.filter((v) => rowState(v) === "breached").length,
      };
    })
    .sort((a, b) => {
      if (b.breachedCount !== a.breachedCount) return b.breachedCount - a.breachedCount;
      return (b.longestBlockedMs ?? 0) - (a.longestBlockedMs ?? 0);
    });
}

export interface AgeingOptions {
  /** Include on-track requests too, for a full ageing list. */
  includeOnTrack?: boolean;
}

/**
 * Requests that have breached or are about to, worst first. Completed requests
 * never appear: they cannot breach anything any more.
 */
export function ageing(
  views: readonly RequestView[],
  options: AgeingOptions = {},
): RequestView[] {
  const wanted: SlaState[] = options.includeOnTrack
    ? ["breached", "at-risk", "on-track"]
    : ["breached", "at-risk"];
  return views
    .filter((v) => !v.metrics.completed && wanted.includes(rowState(v)))
    .sort(byUrgency);
}

export interface QueueSummary {
  total: number;
  live: number;
  completed: number;
  breached: number;
  atRisk: number;
  blocked: number;
  /** Requests whose notes reported a problem — bad dates, unknown stages. */
  withProblems: number;
  /** Requests carrying at least one bounce. */
  bounced: number;
}

/** The one-line state of the queue, for the cockpit header and the daily briefing. */
export function summarise(views: readonly RequestView[]): QueueSummary {
  const live = views.filter((v) => !v.metrics.completed);
  return {
    total: views.length,
    live: live.length,
    completed: views.length - live.length,
    breached: live.filter((v) => rowState(v) === "breached").length,
    atRisk: live.filter((v) => rowState(v) === "at-risk").length,
    blocked: live.filter((v) => v.metrics.blockedOn !== null).length,
    withProblems: views.filter((v) => v.metrics.problems.length > 0).length,
    bounced: views.filter((v) => v.metrics.bounceCount > 0).length,
  };
}
