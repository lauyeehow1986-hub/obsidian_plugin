/**
 * The portfolio roll-up (CLAUDE.md §7 B8).
 *
 * One board: every project by stage, what each is waiting on, which milestones
 * are late, and effort to date against estimate.
 *
 * Every number here comes from an engine that already existed. Dwell and SLA
 * state are `requestMetrics`, unchanged, because a project is a `WorkflowNote`.
 * Effort comes from the §5.3 table filtered on `ref`, which takes a `PRJ-` id
 * exactly as readily as a `REQ-` one — that is the whole of "**no second time
 * log, ever**". If a future portfolio number cannot be built from those, §5.15
 * says stop and ask rather than fork an engine.
 *
 * Pure module: no Obsidian, no Node.
 */

import { compareToEstimate, totalMins, type EstimateComparison } from "../effort/aggregate";
import type { TimeEntry } from "../effort/entry";
import { requestMetrics, type MetricsOptions, type RequestMetrics } from "../request/dwell";
import type { WorkflowSpec } from "../request/workflow";
import {
  milestoneStatuses,
  nextMilestone,
  sortByUrgency,
  type MilestoneStatus,
} from "./milestones";
import type { ProjectNote } from "./project";

export interface ProjectSummary {
  project: ProjectNote;
  /** Label from the spec, falling back to the raw id when the stage is unknown. */
  stageLabel: string;
  metrics: RequestMetrics;
  /** Worst first. */
  milestones: MilestoneStatus[];
  overdueMilestones: number;
  blockedMilestones: number;
  landedMilestones: number;
  /** The most urgent milestone still open, or null when they have all landed. */
  next: MilestoneStatus | null;
  effort: EstimateComparison;
  /**
   * One line naming the holdup: a person when `blocked_on` says so, otherwise
   * the predecessor a milestone is waiting on, otherwise the stage owner.
   *
   * A project stalls for a different reason than a request does — usually
   * because something upstream has not landed rather than because somebody has
   * not replied — so this reads both and says which kind it found.
   */
  waitingOn: string;
}

export interface PortfolioColumn {
  stageId: string;
  label: string;
  projects: ProjectSummary[];
}

export interface Portfolio {
  columns: PortfolioColumn[];
  /** Projects whose stage is not in the spec at all. Never silently hidden. */
  stranded: ProjectSummary[];
  totals: {
    projects: number;
    overdueMilestones: number;
    blockedMilestones: number;
    /** Projects past their own `due`. */
    overdueProjects: number;
  };
}

export interface PortfolioOptions extends MetricsOptions {
  /** How many days ahead a milestone starts reading as due-soon. */
  soonDays?: number;
}

/** Effort logged against this project's own id. */
function effortFor(project: ProjectNote, entries: readonly TimeEntry[]): number {
  const wanted = project.id.trim().toLowerCase();
  if (wanted === "") return 0;
  return totalMins(entries.filter((entry) => entry.ref.trim().toLowerCase() === wanted));
}

function describeHoldup(project: ProjectNote, next: MilestoneStatus | null, stageOwner: string): string {
  if (project.blockedOn !== null && project.blockedOn.trim() !== "") {
    return `Waiting on ${project.blockedOn.trim()}.`;
  }
  if (next !== null && next.state === "blocked") {
    return next.explanation;
  }
  if (next !== null && next.state === "overdue") {
    return next.explanation;
  }
  if (stageOwner !== "") {
    return `With ${stageOwner}.`;
  }
  return "Nothing recorded as blocking this.";
}

/** Summarise one project. Exported because a detail view wants exactly this. */
export function summariseProject(
  project: ProjectNote,
  spec: WorkflowSpec | null,
  entries: readonly TimeEntry[],
  options: PortfolioOptions,
): ProjectSummary {
  const statuses = sortByUrgency(
    milestoneStatuses(project.milestones, {
      now: options.now,
      ...(options.soonDays === undefined ? {} : { soonDays: options.soonDays }),
    }),
  );
  const stage = spec?.stages.find((s) => s.id === project.stage) ?? null;
  const next = nextMilestone(statuses);

  return {
    project,
    stageLabel: stage?.label ?? (project.stage === "" ? "(no stage)" : project.stage),
    metrics: requestMetrics(project, spec, options),
    milestones: statuses,
    overdueMilestones: statuses.filter((s) => s.state === "overdue").length,
    blockedMilestones: statuses.filter((s) => s.state === "blocked").length,
    landedMilestones: statuses.filter((s) => s.state === "done").length,
    next,
    effort: compareToEstimate(project.effortEstimateHours, effortFor(project, entries)),
    waitingOn: describeHoldup(project, next, stage?.owner ?? ""),
  };
}

/**
 * The whole board: one column per stage the spec declares, in spec order.
 *
 * Empty stages are kept. A queue with a gap in it says something — an empty
 * "approval" column between two full ones is the shape of a bottleneck that
 * has just cleared — and dropping it would make the board's columns move about
 * between renders.
 */
export function buildPortfolio(
  projects: readonly ProjectNote[],
  spec: WorkflowSpec | null,
  entries: readonly TimeEntry[],
  options: PortfolioOptions,
): Portfolio {
  const summaries = projects.map((project) => summariseProject(project, spec, entries, options));

  const columns: PortfolioColumn[] = (spec?.stages ?? []).map((stage) => ({
    stageId: stage.id,
    label: stage.label,
    projects: [],
  }));
  const byStage = new Map(columns.map((column) => [column.stageId, column]));
  const stranded: ProjectSummary[] = [];

  for (const summary of summaries) {
    const column = byStage.get(summary.project.stage);
    if (column === undefined) stranded.push(summary);
    else column.projects.push(summary);
  }

  // Within a column: overdue milestones first, then the nearest due date, then
  // id. Same rule as the request boards, so the two read the same way.
  const order = (summary: ProjectSummary): number =>
    summary.overdueMilestones > 0 ? 0 : summary.blockedMilestones > 0 ? 1 : 2;
  for (const column of columns) {
    column.projects.sort((a, b) => {
      const rank = order(a) - order(b);
      if (rank !== 0) return rank;
      const aDue = a.project.due ?? Number.POSITIVE_INFINITY;
      const bDue = b.project.due ?? Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      return (a.project.id || a.project.uid).localeCompare(b.project.id || b.project.uid);
    });
  }

  return {
    columns,
    stranded,
    totals: {
      projects: summaries.length,
      overdueMilestones: summaries.reduce((sum, s) => sum + s.overdueMilestones, 0),
      blockedMilestones: summaries.reduce((sum, s) => sum + s.blockedMilestones, 0),
      overdueProjects: summaries.filter(
        (s) => s.project.due !== null && options.now > s.project.due,
      ).length,
    },
  };
}
