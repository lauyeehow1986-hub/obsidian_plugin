/**
 * Dwell time, age, bounce count and SLA state (CLAUDE.md §5.1).
 *
 * All of it is **computed from `history`, never stored**. Nothing is duplicated
 * into frontmatter where it could go stale, and every number here can be
 * re-derived from a note a human can read.
 *
 * The three numbers always travel together — current dwell, cumulative age and
 * bounce count — because a request sent back twice looks fresh on current dwell
 * alone, and that is precisely the case worth catching.
 *
 * Pure module: no Obsidian, no Node.
 */

import { median } from "../stats/summary";
import { DAY_MS } from "../time/dates";
import type { HistoryEntry, WorkflowNote } from "./request";
import { isBackwardMove, resolveStage, type WorkflowSpec } from "./workflow";

export type SlaState = "no-target" | "on-track" | "at-risk" | "breached";

export interface MetricsOptions {
  now: number;
  /** Fraction of the stage target at which a request starts showing as at-risk. */
  atRiskFraction?: number;
  /** How many days before `due` a request starts showing as at-risk. */
  dueRiskDays?: number;
}

/** One continuous occupancy of one stage. */
export interface StageSegment {
  stageId: string;
  enteredAt: number;
  /** Null while the request is still in this stage. */
  leftAt: number | null;
  ms: number;
  open: boolean;
}

export interface SlaAssessment {
  state: SlaState;
  /** The target, in days, or null when the spec sets none. */
  targetDays: number | null;
  /** Milliseconds past the target. Zero unless breached. */
  overByMs: number;
}

export interface RequestMetrics {
  /** Time in the current stage. Null when the note carries no usable dates. */
  currentDwellMs: number | null;
  /**
   * Time since the request arrived. Frozen at the moment a terminal stage was
   * entered, so a delivered request does not keep ageing on the board.
   */
  totalAgeMs: number | null;
  /** Arrival → terminal stage. Non-null only once the request is complete. */
  turnaroundMs: number | null;
  completed: boolean;

  segments: StageSegment[];
  /** Total time in each stage across the whole history, longest first. */
  perStageMs: { stageId: string; ms: number; visits: number }[];

  /** Moves to an earlier stage — the rework signal. */
  bounceCount: number;
  /** Entries into a stage the request had already been in. */
  revisitCount: number;

  blockedOn: string | null;
  /** How long the current holdup has lasted. */
  blockedForMs: number | null;

  /** Against the current stage's `sla_days`. */
  stageSla: SlaAssessment;
  /** Against the note's own `due` date. */
  dueSla: SlaAssessment;

  /** Anything that made the numbers less trustworthy than they look. */
  problems: string[];
}

/**
 * When the request started. `received` wins over the first history entry: a
 * note may be created in the vault days after the request actually arrived,
 * and age should measure the requester's wait, not ours.
 */
function startedAt(request: WorkflowNote): number | null {
  if (request.received !== null) return request.received;
  return request.history[0]?.at ?? null;
}

/**
 * Fold migration entries into the occupancy they relabel (§5.2).
 *
 * A migration renames the stage a request is *already* in. Treated as an
 * ordinary history entry it would close the open occupancy and start a fresh
 * one, which would reset the dwell clock, invent a segment in the median-dwell
 * statistics, and — when the new stage sits earlier in the spec — count as a
 * bounce. All three would be lies about the request: nothing happened to it,
 * we renamed a stage. So the entry rewrites the previous entry's `to` and
 * contributes no boundary of its own.
 *
 * A migration entry with nothing before it is kept as a real entry; there is no
 * occupancy to relabel, so it is the first one.
 */
export function effectiveHistory(history: readonly HistoryEntry[]): HistoryEntry[] {
  const folded: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = folded[folded.length - 1];
    if (entry.migration && previous !== undefined) {
      folded[folded.length - 1] = { ...previous, to: entry.to };
    } else {
      folded.push(entry);
    }
  }
  return folded;
}

/** Split the history into stage occupancies. */
export function stageSegments(
  request: WorkflowNote,
  spec: WorkflowSpec | null,
  now: number,
): StageSegment[] {
  const history = effectiveHistory(request.history);
  if (history.length === 0) return [];

  const segments: StageSegment[] = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!;
    const next = history[i + 1];
    const isLast = next === undefined;
    const terminal = spec ? (resolveStage(spec, entry.to)?.terminal ?? false) : false;

    // A terminal stage stops the clock; "delivered 90 days ago" is not 90 days
    // of dwell anybody is accountable for.
    const leftAt = isLast ? (terminal ? entry.at : null) : next.at;
    const end = leftAt ?? now;
    segments.push({
      stageId: entry.to,
      enteredAt: entry.at,
      leftAt,
      ms: Math.max(0, end - entry.at),
      open: isLast && !terminal,
    });
  }
  return segments;
}

function assessStage(dwellMs: number | null, targetDays: number | null, atRiskFraction: number): SlaAssessment {
  if (targetDays === null || dwellMs === null) {
    return { state: "no-target", targetDays, overByMs: 0 };
  }
  const targetMs = targetDays * DAY_MS;
  if (dwellMs > targetMs) {
    return { state: "breached", targetDays, overByMs: dwellMs - targetMs };
  }
  if (targetMs > 0 && dwellMs >= targetMs * atRiskFraction) {
    return { state: "at-risk", targetDays, overByMs: 0 };
  }
  return { state: "on-track", targetDays, overByMs: 0 };
}

function assessDue(due: number | null, now: number, riskDays: number): SlaAssessment {
  if (due === null) return { state: "no-target", targetDays: null, overByMs: 0 };
  if (now > due) return { state: "breached", targetDays: null, overByMs: now - due };
  if (now >= due - riskDays * DAY_MS) return { state: "at-risk", targetDays: null, overByMs: 0 };
  return { state: "on-track", targetDays: null, overByMs: 0 };
}

/** Everything the boards need about one request, computed fresh. */
export function requestMetrics(
  request: WorkflowNote,
  spec: WorkflowSpec | null,
  options: MetricsOptions,
): RequestMetrics {
  const { now } = options;
  const atRiskFraction = options.atRiskFraction ?? 0.8;
  const dueRiskDays = options.dueRiskDays ?? 3;
  const problems: string[] = [];

  const segments = stageSegments(request, spec, now);
  const history = effectiveHistory(request.history);

  if (history.length === 0) {
    problems.push("No history entries, so dwell time cannot be measured.");
  }

  const last = history[history.length - 1];
  const currentStage = spec && last ? resolveStage(spec, last.to) : null;
  if (spec && last && currentStage === null) {
    problems.push(
      `Stage "${last.to}" is not in workflow "${spec.id}" v${spec.version}. It may need migrating.`,
    );
  }
  const completed = currentStage?.terminal ?? false;

  const currentDwellMs = last ? Math.max(0, now - last.at) : null;

  const start = startedAt(request);
  const stopped = completed && last ? last.at : now;
  const totalAgeMs = start === null ? null : Math.max(0, stopped - start);
  const turnaroundMs = completed && start !== null && last ? Math.max(0, last.at - start) : null;

  if (start !== null && last && last.at < start) {
    problems.push("The last history entry predates `received`; the dates disagree.");
  }

  // Per-stage roll-up.
  const totals = new Map<string, { ms: number; visits: number }>();
  for (const segment of segments) {
    const current = totals.get(segment.stageId) ?? { ms: 0, visits: 0 };
    current.ms += segment.ms;
    current.visits += 1;
    totals.set(segment.stageId, current);
  }
  const perStageMs = [...totals.entries()]
    .map(([stageId, v]) => ({ stageId, ...v }))
    .sort((a, b) => b.ms - a.ms);

  // Bounces and revisits.
  let bounceCount = 0;
  let revisitCount = 0;
  const visited = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const to = history[i]!.to;
    if (visited.has(to)) revisitCount++;
    visited.add(to);
    const previous = history[i - 1];
    if (previous && spec && isBackwardMove(spec, previous.to, to)) bounceCount++;
  }

  // Holdup. `blocked_since` is authoritative when set; otherwise the holdup has
  // lasted as long as the stage the request is stuck in.
  const blockedOn = request.blockedOn ?? last?.blockedOn ?? null;
  const blockedFrom = request.blockedSince ?? last?.at ?? null;
  const blockedForMs = blockedOn && blockedFrom !== null ? Math.max(0, now - blockedFrom) : null;

  // A stage target from the note overrides the spec's, because a request may
  // carry an agreed turnaround of its own.
  const targetDays = currentStage?.slaDays ?? null;

  return {
    currentDwellMs,
    totalAgeMs,
    turnaroundMs,
    completed,
    segments,
    perStageMs,
    bounceCount,
    revisitCount,
    blockedOn,
    blockedForMs,
    stageSla: completed
      ? { state: "no-target", targetDays, overByMs: 0 }
      : assessStage(currentDwellMs, targetDays, atRiskFraction),
    dueSla: completed ? { state: "no-target", targetDays: null, overByMs: 0 } : assessDue(request.due, now, dueRiskDays),
    problems,
  };
}

/** The worse of two SLA states, for a single badge on a row. */
export function worstSlaState(...states: SlaState[]): SlaState {
  const rank: Record<SlaState, number> = {
    "no-target": 0,
    "on-track": 1,
    "at-risk": 2,
    breached: 3,
  };
  return states.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "no-target" as SlaState);
}

/** Re-exported so callers of the dwell maths do not have to know where it lives. */
export { median };

export interface StageDwellStats {
  stageId: string;
  /** Median of completed occupancies — the systemic bottleneck signal. */
  medianClosedMs: number | null;
  closedCount: number;
  /** Requests sitting in this stage right now. */
  openCount: number;
  longestOpenMs: number | null;
}

/**
 * Median dwell per stage across many requests (§5.1: "which stage is
 * *systematically* slowest").
 *
 * Closed and open occupancies are reported separately on purpose. Mixing them
 * drags the median down, because a request that entered a stage this morning
 * contributes a few hours to a statistic meant to describe how long that stage
 * takes.
 */
export function stageDwellStats(
  requests: readonly { request: WorkflowNote; metrics: RequestMetrics }[],
  spec: WorkflowSpec | null,
): StageDwellStats[] {
  const closed = new Map<string, number[]>();
  const open = new Map<string, number[]>();

  for (const { metrics } of requests) {
    for (const segment of metrics.segments) {
      const bucket = segment.open ? open : closed;
      const list = bucket.get(segment.stageId) ?? [];
      list.push(segment.ms);
      bucket.set(segment.stageId, list);
    }
  }

  const stageIds = spec
    ? spec.stages.map((s) => s.id)
    : [...new Set([...closed.keys(), ...open.keys()])];
  for (const id of [...closed.keys(), ...open.keys()]) {
    if (!stageIds.includes(id)) stageIds.push(id);
  }

  return stageIds.map((stageId) => {
    const closedList = closed.get(stageId) ?? [];
    const openList = open.get(stageId) ?? [];
    return {
      stageId,
      medianClosedMs: median(closedList),
      closedCount: closedList.length,
      openCount: openList.length,
      longestOpenMs: openList.length === 0 ? null : Math.max(...openList),
    };
  });
}
