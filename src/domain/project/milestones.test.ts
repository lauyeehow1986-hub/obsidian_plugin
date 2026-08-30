import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { cycleThrough, milestoneStatuses, nextMilestone, sortByUrgency } from "./milestones";
import type { Milestone } from "./project";
import { NOW } from "./testFixtures";

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

function milestone(overrides: Partial<Milestone> & { id: string }): Milestone {
  return { title: "", due: null, done: null, blockedBy: [], event: "", ...overrides };
}

describe("finding a cycle", () => {
  it("finds none in a straight chain", () => {
    expect(
      cycleThrough([
        milestone({ id: "M1" }),
        milestone({ id: "M2", blockedBy: ["M1"] }),
        milestone({ id: "M3", blockedBy: ["M2"] }),
      ]),
    ).toBeNull();
  });

  it("finds none in a diamond", () => {
    expect(
      cycleThrough([
        milestone({ id: "M1" }),
        milestone({ id: "M2", blockedBy: ["M1"] }),
        milestone({ id: "M3", blockedBy: ["M1"] }),
        milestone({ id: "M4", blockedBy: ["M2", "M3"] }),
      ]),
    ).toBeNull();
  });

  it("names the loop, closing it on the id it started from", () => {
    const cycle = cycleThrough([
      milestone({ id: "M1", blockedBy: ["M3"] }),
      milestone({ id: "M2", blockedBy: ["M1"] }),
      milestone({ id: "M3", blockedBy: ["M2"] }),
    ]);
    expect(cycle).not.toBeNull();
    expect(at(cycle!, 0)).toBe(at(cycle!, cycle!.length - 1));
    expect(new Set(cycle!)).toEqual(new Set(["M1", "M2", "M3"]));
  });

  it("finds a self-edge", () => {
    expect(cycleThrough([milestone({ id: "M1", blockedBy: ["M1"] })])).toEqual(["M1", "M1"]);
  });

  it("finds a cycle that sits off to one side of an acyclic graph", () => {
    // The DFS must not stop once it has cleared the first component.
    const cycle = cycleThrough([
      milestone({ id: "A1" }),
      milestone({ id: "A2", blockedBy: ["A1"] }),
      milestone({ id: "B1", blockedBy: ["B2"] }),
      milestone({ id: "B2", blockedBy: ["B1"] }),
    ]);
    expect(new Set(cycle ?? [])).toEqual(new Set(["B1", "B2"]));
  });

  it("ignores an edge pointing at nothing", () => {
    expect(cycleThrough([milestone({ id: "M1", blockedBy: ["nowhere"] })])).toBeNull();
  });

  it("does not blow the stack on a long chain", () => {
    // A note is untrusted input; recursion depth is not something to hand it.
    const chain = Array.from({ length: 20_000 }, (_, i) =>
      milestone({ id: `M${i}`, blockedBy: i === 0 ? [] : [`M${i - 1}`] }),
    );
    expect(cycleThrough(chain)).toBeNull();
  });
});

describe("classifying a milestone", () => {
  const options = { now: NOW };

  it("calls a landed milestone done, whatever its date said", () => {
    const [status] = milestoneStatuses(
      [milestone({ id: "M1", due: NOW - 30 * DAY_MS, done: NOW - 31 * DAY_MS })],
      options,
    );
    expect(status!.state).toBe("done");
  });

  it("calls a milestone blocked when its predecessor has not landed", () => {
    const statuses = milestoneStatuses(
      [
        milestone({ id: "M1", title: "Baseline audit" }),
        milestone({ id: "M2", title: "SOP approved", blockedBy: ["M1"] }),
      ],
      options,
    );
    expect(at(statuses, 1).state).toBe("blocked");
    expect(at(statuses, 1).waitingOn).toEqual(["M1"]);
    expect(at(statuses, 1).explanation).toContain("Baseline audit");
  });

  it("unblocks a milestone once its predecessor lands", () => {
    const statuses = milestoneStatuses(
      [
        milestone({ id: "M1", done: NOW - DAY_MS }),
        milestone({ id: "M2", blockedBy: ["M1"], due: NOW + 90 * DAY_MS }),
      ],
      options,
    );
    expect(at(statuses, 1).state).toBe("open");
    expect(at(statuses, 1).waitingOn).toEqual([]);
  });

  it("prefers blocked over overdue, because the predecessor is the real holdup", () => {
    // Telling somebody to hurry up on M2 when M1 is the holdup is exactly the
    // misdirection this plugin exists to stop.
    const statuses = milestoneStatuses(
      [
        milestone({ id: "M1", title: "Baseline audit" }),
        milestone({ id: "M2", blockedBy: ["M1"], due: NOW - 10 * DAY_MS }),
      ],
      options,
    );
    expect(at(statuses, 1).state).toBe("blocked");
    expect(at(statuses, 1).overdueByMs).toBe(10 * DAY_MS);
  });

  it("calls an unblocked milestone past its date overdue", () => {
    const [status] = milestoneStatuses([milestone({ id: "M1", due: NOW - 3 * DAY_MS })], options);
    expect(status!.state).toBe("overdue");
    expect(status!.overdueByMs).toBe(3 * DAY_MS);
  });

  it("calls a milestone inside the window due-soon", () => {
    const [status] = milestoneStatuses([milestone({ id: "M1", due: NOW + 5 * DAY_MS })], options);
    expect(status!.state).toBe("due-soon");
  });

  it("leaves a dateless milestone open rather than inventing a deadline", () => {
    const [status] = milestoneStatuses([milestone({ id: "M1" })], options);
    expect(status!.state).toBe("open");
    expect(status!.explanation).toContain("no date");
  });

  it("falls back to the id when a milestone has no title", () => {
    const [status] = milestoneStatuses([milestone({ id: "M7" })], options);
    expect(status!.explanation).toContain("M7");
  });
});

describe("ordering", () => {
  const options = { now: NOW };

  it("puts overdue first and done last", () => {
    const statuses = sortByUrgency(
      milestoneStatuses(
        [
          milestone({ id: "M4", done: NOW - DAY_MS }),
          milestone({ id: "M3" }),
          milestone({ id: "M2", due: NOW + 3 * DAY_MS }),
          milestone({ id: "M1", due: NOW - DAY_MS }),
        ],
        options,
      ),
    );
    expect(statuses.map((s) => s.milestone.id)).toEqual(["M1", "M2", "M3", "M4"]);
  });

  it("offers the most urgent open milestone as the next one", () => {
    const next = nextMilestone(
      milestoneStatuses(
        [
          milestone({ id: "M1", done: NOW - DAY_MS }),
          milestone({ id: "M2", due: NOW - 2 * DAY_MS }),
        ],
        options,
      ),
    );
    expect(next?.milestone.id).toBe("M2");
  });

  it("offers nothing once everything has landed", () => {
    const next = nextMilestone(
      milestoneStatuses([milestone({ id: "M1", done: NOW - DAY_MS })], options),
    );
    expect(next).toBeNull();
  });
});
