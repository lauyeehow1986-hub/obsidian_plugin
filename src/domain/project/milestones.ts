/**
 * Milestones and the `blocked_by` edges between them (CLAUDE.md §5.15).
 *
 * This is the one genuinely new concept a project brings. A request's
 * `blocked_on` names a *person*; `blocked_by` names a *predecessor*, and it is
 * what lets a portfolio board say "M2 cannot move because M1 has not landed"
 * rather than merely "M2 is late".
 *
 * Deliberately absent, per §5.15: percent-complete, burndown, resource
 * levelling and anything else that asks "how complete is this, roughly". A
 * milestone landed on a day or it has not.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { Milestone } from "./project";

const DAY_MS = 86_400_000;

/**
 * The states a milestone can be in, worst first.
 *
 * `blocked` outranks `late`: a milestone whose predecessor has not landed is
 * not a scheduling failure of its own, and telling somebody to hurry up on M2
 * when M1 is the actual holdup is exactly the misdirection this whole plugin
 * exists to stop.
 */
export type MilestoneState = "done" | "blocked" | "overdue" | "due-soon" | "open";

export interface MilestoneStatus {
  milestone: Milestone;
  state: MilestoneState;
  /** Ids of predecessors that have not landed. Empty unless `state` is blocked. */
  waitingOn: string[];
  /** Milliseconds past `due`. Zero unless overdue. */
  overdueByMs: number;
  /** One line for a board or a briefing. Never colour alone (§6). */
  explanation: string;
}

/**
 * The first `blocked_by` cycle, as the ids around it, or null when there is
 * none. The returned path repeats its first id last — `["M2","M3","M2"]` — so
 * a message can name the loop the way a person would read it.
 *
 * Iterative depth-first search with an explicit stack: a project's milestone
 * list is small, but a hand-written note is untrusted input and recursion depth
 * is not something to hand to it.
 */
export function cycleThrough(milestones: readonly Milestone[]): string[] | null {
  const edges = new Map<string, readonly string[]>();
  for (const milestone of milestones) edges.set(milestone.id, milestone.blockedBy);

  const UNVISITED = 0;
  const OPEN = 1;
  const CLOSED = 2;
  const mark = new Map<string, number>();
  for (const id of edges.keys()) mark.set(id, UNVISITED);

  for (const start of edges.keys()) {
    if (mark.get(start) !== UNVISITED) continue;

    const path: string[] = [];
    // Each frame carries how far through its own edge list we have walked.
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    mark.set(start, OPEN);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const outgoing = edges.get(frame.id) ?? [];

      if (frame.next >= outgoing.length) {
        mark.set(frame.id, CLOSED);
        stack.pop();
        path.pop();
        continue;
      }

      const next = outgoing[frame.next]!;
      frame.next += 1;
      if (!edges.has(next)) continue;

      const state = mark.get(next);
      if (state === OPEN) {
        // Cut the path down to where the loop closes, then close it.
        const from = path.indexOf(next);
        return [...path.slice(from), next];
      }
      if (state === CLOSED) continue;

      mark.set(next, OPEN);
      path.push(next);
      stack.push({ id: next, next: 0 });
    }
  }

  return null;
}

export interface MilestoneOptions {
  now: number;
  /** How many days ahead of `due` a milestone starts reading as due-soon. */
  soonDays?: number;
}

function titleOf(milestone: Milestone): string {
  return milestone.title.trim() === "" ? milestone.id : milestone.title.trim();
}

/**
 * Classify every milestone, resolving `blocked_by` against the same list.
 *
 * Assumes the edges are acyclic — `parseProject` drops any cycle before this
 * ever sees the list — so a predecessor chain terminates.
 */
export function milestoneStatuses(
  milestones: readonly Milestone[],
  options: MilestoneOptions,
): MilestoneStatus[] {
  const { now } = options;
  const soonDays = options.soonDays ?? 14;
  const byId = new Map(milestones.map((m) => [m.id, m]));

  return milestones.map((milestone) => {
    if (milestone.done !== null) {
      return {
        milestone,
        state: "done" as const,
        waitingOn: [],
        overdueByMs: 0,
        explanation: `${titleOf(milestone)} landed.`,
      };
    }

    const waitingOn = milestone.blockedBy.filter((id) => {
      const predecessor = byId.get(id);
      return predecessor !== undefined && predecessor.done === null;
    });

    if (waitingOn.length > 0) {
      const names = waitingOn.map((id) => {
        const predecessor = byId.get(id);
        return predecessor === undefined ? id : `${id} (${titleOf(predecessor)})`;
      });
      return {
        milestone,
        state: "blocked" as const,
        waitingOn,
        overdueByMs: milestone.due !== null && now > milestone.due ? now - milestone.due : 0,
        explanation: `${titleOf(milestone)} cannot move until ${names.join(" and ")} lands.`,
      };
    }

    if (milestone.due === null) {
      return {
        milestone,
        state: "open" as const,
        waitingOn: [],
        overdueByMs: 0,
        explanation: `${titleOf(milestone)} is open, with no date set.`,
      };
    }

    if (now > milestone.due) {
      const overdueByMs = now - milestone.due;
      return {
        milestone,
        state: "overdue" as const,
        waitingOn: [],
        overdueByMs,
        explanation: `${titleOf(milestone)} is past its date and nothing is blocking it.`,
      };
    }

    if (now >= milestone.due - soonDays * DAY_MS) {
      return {
        milestone,
        state: "due-soon" as const,
        waitingOn: [],
        overdueByMs: 0,
        explanation: `${titleOf(milestone)} is due within ${soonDays} days.`,
      };
    }

    return {
      milestone,
      state: "open" as const,
      waitingOn: [],
      overdueByMs: 0,
      explanation: `${titleOf(milestone)} is open.`,
    };
  });
}

const STATE_ORDER: Record<MilestoneState, number> = {
  overdue: 0,
  "due-soon": 1,
  blocked: 2,
  open: 3,
  done: 4,
};

/** Worst first, then by date, then by id, so a board is stable between renders. */
export function sortByUrgency(statuses: readonly MilestoneStatus[]): MilestoneStatus[] {
  return [...statuses].sort((a, b) => {
    const rank = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (rank !== 0) return rank;
    const aDue = a.milestone.due ?? Number.POSITIVE_INFINITY;
    const bDue = b.milestone.due ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return a.milestone.id.localeCompare(b.milestone.id);
  });
}

/**
 * The milestone to put in front of somebody: the most urgent one still open.
 *
 * Null when everything has landed — which is a real answer, and the board says
 * so rather than showing a blank cell.
 */
export function nextMilestone(statuses: readonly MilestoneStatus[]): MilestoneStatus | null {
  const open = sortByUrgency(statuses).filter((status) => status.state !== "done");
  return open[0] ?? null;
}
