import { describe, expect, it } from "vitest";
import { rollUp } from "../effort/aggregate";
import type { TimeEntry } from "../effort/entry";
import { applyTransition, evaluateTransition, TransitionRefused } from "../request/transition";
import { DAY_MS } from "../time/dates";
import { buildPortfolio, summariseProject } from "./portfolio";
import { parseProject, type ProjectNote } from "./project";
import { NOW, projectFrontmatter, projectSpec } from "./testFixtures";

const spec = projectSpec();

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

function project(overrides: Record<string, unknown> = {}): ProjectNote {
  return parseProject(projectFrontmatter(overrides)).project;
}

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    date: "2026-07-14",
    start: "09:00",
    end: "10:00",
    mins: 60,
    person: "yh",
    ref: "PRJ-2026-004",
    activity: "meeting",
    study: "",
    costCentre: "RC-2026-07",
    note: "",
    ...overrides,
  };
}

describe("the workflow engine drives a project unchanged", () => {
  // §5.15: "If a proposed project feature cannot be expressed as a workflow
  // spec plus a query, that is the signal to stop and ask — not to fork the
  // engine." These tests are that claim, checked.

  it("refuses a transition the spec does not allow, naming the stages", () => {
    const decision = evaluateTransition({
      spec,
      request: project(),
      to: "closed",
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals.map((r) => r.message).join(" ")).toContain("Closed");
  });

  it("allows a transition the spec does allow, and writes the same history entry", () => {
    const effect = applyTransition({
      spec,
      request: project(),
      to: "embedding",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["stage"]).toBe("embedding");
    expect(effect.patch.appendHistory?.["to"]).toBe("embedding");
    expect(at(effect.audit, 0).action).toBe("stage-change");
    expect(at(effect.audit, 0).subject).toBe("PRJ-2026-004");
  });

  it("quarantines a project whose workflow_version is behind the spec", () => {
    expect(() =>
      applyTransition({
        spec: projectSpec({ version: 2 }),
        request: project(),
        to: "embedding",
        now: NOW,
        actor: "yh",
      }),
    ).toThrow(TransitionRefused);
  });

  it("gives no reconciliation warning, because a project has nothing upstream", () => {
    const decision = evaluateTransition({ spec, request: project(), to: "embedding", now: NOW });
    expect(decision.warnings.join(" ")).not.toContain("reconciled");
  });
});

describe("summarising one project", () => {
  it("computes dwell from the history, exactly as a request does", () => {
    const summary = summariseProject(project(), spec, [], { now: NOW });
    // Entered `delivery` on 2026-07-01; "now" is 2026-07-28. Asserted in whole
    // days: a bare date parses to UTC midnight and NOW is local noon, so the
    // exact millisecond count moves with the machine's offset and the day
    // count does not.
    expect(Math.floor((summary.metrics.currentDwellMs ?? 0) / DAY_MS)).toBe(27);
    expect(summary.stageLabel).toBe("Delivery");
  });

  it("counts landed, blocked and overdue milestones separately", () => {
    const summary = summariseProject(project(), spec, [], { now: NOW });
    expect(summary.landedMilestones).toBe(1);
    expect(summary.blockedMilestones).toBe(1); // M3 waits on M2
    expect(summary.overdueMilestones).toBe(0);
  });

  it("names the predecessor as the holdup when nothing names a person", () => {
    const summary = summariseProject(project(), spec, [], { now: NOW });
    expect(summary.waitingOn).toContain("SOP approved by committee");
  });

  it("prefers a named person over a predecessor, because a person can be chased", () => {
    const summary = summariseProject(project({ blocked_on: "[[Prof C Lim]]" }), spec, [], {
      now: NOW,
    });
    expect(summary.waitingOn).toBe("Waiting on [[Prof C Lim]].");
  });

  it("falls back to the stage owner when nothing is blocking at all", () => {
    const summary = summariseProject(
      project({ milestones: [], stage: "approval", history: [{ at: "2026-07-01", to: "approval" }] }),
      spec,
      [],
      { now: NOW },
    );
    expect(summary.waitingOn).toBe("With sponsor.");
  });
});

describe("effort rolls up through `ref`, with no second time log", () => {
  // §5.15: "Effort attributes through `ref`, not through a new log." The §5.3
  // table already carries `ref`, and `ref` takes a PRJ- id as readily as a
  // REQ- one. These tests pin that, because building a second log is exactly
  // the failure the section forbids.

  it("totals the entries logged against the project's own id", () => {
    const entries = [entry(), entry({ mins: 90 }), entry({ ref: "REQ-2026-014", mins: 300 })];
    const summary = summariseProject(project(), spec, entries, { now: NOW });
    expect(summary.effort.actualMins).toBe(150);
  });

  it("compares that total against the estimate with the same function a request uses", () => {
    const entries = [entry({ mins: 60 * 45 })]; // 45h against a 40h estimate
    const summary = summariseProject(project(), spec, entries, { now: NOW });
    expect(summary.effort.state).toBe("over");
    expect(summary.effort.estimateMins).toBe(40 * 60);
  });

  it("puts PRJ- and REQ- effort side by side in one roll-up", () => {
    // The proof that there is one log, not two: a single `rollUp` by `ref`
    // returns both kinds of work without knowing either prefix exists.
    const buckets = rollUp(
      [entry({ mins: 150 }), entry({ ref: "REQ-2026-014", mins: 300 })],
      "ref",
    );
    expect(buckets.map((b) => b.key).sort()).toEqual(["PRJ-2026-004", "REQ-2026-014"]);
  });

  it("says there is no estimate rather than inventing one", () => {
    const summary = summariseProject(project({ effort_estimate_hours: null }), spec, [], {
      now: NOW,
    });
    expect(summary.effort.state).toBe("no-estimate");
  });
});

describe("the portfolio board", () => {
  it("gives one column per stage, in spec order, keeping the empty ones", () => {
    const board = buildPortfolio([project()], spec, [], { now: NOW });
    expect(board.columns.map((c) => c.stageId)).toEqual([
      "scoping",
      "approval",
      "delivery",
      "embedding",
      "closed",
      "paused",
      "abandoned",
    ]);
    expect(at(board.columns, 2).projects).toHaveLength(1);
    expect(at(board.columns, 0).projects).toHaveLength(0);
  });

  it("lists a project whose stage is not in the spec rather than hiding it", () => {
    const board = buildPortfolio([project({ stage: "somewhere-else" })], spec, [], { now: NOW });
    expect(board.stranded).toHaveLength(1);
    expect(board.columns.every((c) => c.projects.length === 0)).toBe(true);
  });

  it("sorts a column with overdue milestones first", () => {
    const late = project({
      uid: "01JZQ8MW5T3K7XBN2FHVCD9RGC",
      id: "PRJ-2026-005",
      milestones: [{ id: "M1", title: "Late one", due: "2026-06-01" }],
    });
    const board = buildPortfolio([project(), late], spec, [], { now: NOW });
    expect(at(at(board.columns, 2).projects, 0).project.id).toBe("PRJ-2026-005");
  });

  it("totals what the board is for: late and blocked milestones across everything", () => {
    const late = project({
      uid: "01JZQ8MW5T3K7XBN2FHVCD9RGC",
      id: "PRJ-2026-005",
      milestones: [{ id: "M1", title: "Late one", due: "2026-06-01" }],
    });
    const board = buildPortfolio([project(), late], spec, [], { now: NOW });
    expect(board.totals).toEqual({
      projects: 2,
      overdueMilestones: 1,
      blockedMilestones: 1,
      overdueProjects: 0,
    });
  });

  it("still builds a board when no spec has loaded, rather than showing nothing", () => {
    const board = buildPortfolio([project()], null, [], { now: NOW });
    expect(board.columns).toEqual([]);
    expect(board.stranded).toHaveLength(1);
  });
});
