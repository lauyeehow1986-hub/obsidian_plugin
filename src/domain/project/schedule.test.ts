import { describe, expect, it } from "vitest";
import { parseEventNote } from "../events/event";
import { buildSchedule, materialisePlan } from "../events/schedule";
import { toVaultDate } from "../time/dates";
import { parseProject } from "./project";
import { milestoneEvents } from "./schedule";
import { NOW, projectFrontmatter } from "./testFixtures";

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) throw new Error(`expected exactly one ${what}, got ${items.length}`);
  return items[0]!;
}

const PATH = "15 Projects/PRJ-2026-004.md";

function projects(overrides: Record<string, unknown> = {}) {
  return [{ project: parseProject(projectFrontmatter(overrides)).project, path: PATH }];
}

describe("milestones as events", () => {
  it("offers every open, dated milestone", () => {
    const events = milestoneEvents(projects());
    // M1 landed; M2 and M3 are open and dated.
    expect(events.map((e) => e.due)).toEqual(["2026-09-30", "2026-11-30"]);
  });

  it("drops a landed milestone, because a date that was met is not a deadline", () => {
    const events = milestoneEvents(
      projects({ milestones: [{ id: "M1", title: "Done", due: "2026-06-30", done: "2026-06-27" }] }),
    );
    expect(events).toEqual([]);
  });

  it("drops a dateless milestone rather than inventing a date for it", () => {
    const events = milestoneEvents(projects({ milestones: [{ id: "M1", title: "Someday" }] }));
    expect(events).toEqual([]);
  });

  it("names the project and the milestone together, so a briefing line stands alone", () => {
    const event = only(
      milestoneEvents(
        projects({ milestones: [{ id: "M2", title: "SOP approved", due: "2026-09-30" }] }),
      ),
      "milestone event",
    );
    expect(event.title).toBe("Research data governance rollout — SOP approved");
    expect(event.id).toBe("PRJ-2026-004 M2");
  });

  it("gives a stable uid per milestone, so re-reading does not double it up", () => {
    const first = milestoneEvents(projects()).map((e) => e.uid);
    const second = milestoneEvents(projects()).map((e) => e.uid);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("says what breaks when something is genuinely waiting behind it", () => {
    const events = milestoneEvents(projects());
    const m2 = events.find((e) => e.id.endsWith("M2"));
    expect(m2?.consequence).toContain("M3");
  });

  it("says nothing rather than inventing a consequence when nothing waits", () => {
    // §5.7's rule earns its keep only if the sentence is true. A manufactured
    // one teaches the reader to skip the real ones.
    const events = milestoneEvents(projects());
    const m3 = events.find((e) => e.id.endsWith("M3"));
    expect(m3?.consequence).toBe("");
  });

  it("points at the project note, so the briefing link opens something real", () => {
    expect(milestoneEvents(projects()).every((e) => e.path === PATH)).toBe(true);
  });
});

describe("milestones reach the existing engines, and only those", () => {
  it("appears on the schedule beside ordinary events, with no new code", () => {
    const schedule = buildSchedule(milestoneEvents(projects()), {
      today: toVaultDate(NOW),
      horizonDays: 180,
      defaultLeadDays: [30, 7, 1],
    });
    expect(schedule).toHaveLength(2);
    expect(schedule.every((occurrence) => occurrence.date !== "")).toBe(true);
  });

  it("is never a materialise target, so nothing can write a date into a project note", () => {
    // A milestone event names the project's own path. If it ever reached the
    // materialiser, the write would land in the project's frontmatter.
    expect(materialisePlan(milestoneEvents(projects()))).toEqual([]);
  });

  it("marks itself as derived, naming the project and the milestone", () => {
    // Found by pressing "Done" on a milestone in the deadline board: the
    // completion path resolved a file from `path` — which is the *project's*
    // note — and would have written `last_completed` into it while leaving the
    // milestone open. `derivedFrom` is what any writer checks first.
    const events = milestoneEvents(projects());
    for (const event of events) {
      expect(event.derivedFrom?.kind).toBe("milestone");
      expect(event.derivedFrom?.noteUid).toBe("01JZQ8MW5T3K7XBN2FHVCD9RGB");
      expect(event.derivedFrom?.itemId).toMatch(/^M\d$/);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it("is the only kind of occurrence that carries the marker", () => {
    // A real event note must never look derived, or a genuine completion would
    // be routed away from the file that should receive it.
    const real = parseEventNote("60 Events/EVT-2026-001.md", {
      type: "event",
      id: "EVT-2026-001",
      title: "Grant submission",
      due: "2026-10-15",
    });
    expect(real.derivedFrom).toBeUndefined();
  });
});
