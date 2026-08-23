import { describe, expect, it } from "vitest";
import { parseEventNote, type EventNote } from "./event";
import {
  alertingCount,
  buildSchedule,
  completion,
  describeAlerts,
  lapsed,
  leadDates,
  materialisePlan,
  occurrenceDate,
} from "./schedule";

const TODAY = "2026-08-23";
const OPTIONS = { today: TODAY, horizonDays: 60, defaultLeadDays: [30, 7, 1] };

function note(extra: Record<string, unknown>): EventNote {
  return parseEventNote(`60 Events/${String(extra["id"] ?? "X")}.md`, {
    type: "obligation",
    consequence: "Access withdrawn.",
    ...extra,
  });
}

describe("occurrenceDate", () => {
  it("prefers the date written on the note", () => {
    const n = note({ id: "A", due: "2026-09-15", recurrence: { every: 1, unit: "year", anchor: "2026-03-31" } });
    expect(occurrenceDate(n)).toEqual({ date: "2026-09-15", source: "due" });
  });

  it("computes one when the note carries only a rule", () => {
    const n = note({ id: "B", recurrence: { every: 2, unit: "year", anchor: "2025-11-01" }, last_completed: "2025-11-01" });
    expect(occurrenceDate(n)).toEqual({ date: "2027-11-01", source: "computed" });
  });

  it("moves on once the written date has been completed", () => {
    // The board self-corrects when someone records the completion by hand
    // rather than through the command.
    const n = note({
      id: "C",
      due: "2026-03-31",
      last_completed: "2026-03-31",
      recurrence: { every: 1, unit: "year", anchor: "2026-03-31" },
    });
    expect(occurrenceDate(n)).toEqual({ date: "2027-03-31", source: "computed" });
  });

  it("keeps the written date when the completion predates it", () => {
    const n = note({
      id: "D",
      due: "2026-09-15",
      last_completed: "2025-09-12",
      recurrence: { every: 1, unit: "year", anchor: "2026-09-15" },
    });
    expect(occurrenceDate(n).date).toBe("2026-09-15");
  });

  it("has nothing to say about a note with neither", () => {
    expect(occurrenceDate(note({ id: "E" }))).toEqual({ date: "", source: "none" });
  });
});

describe("buildSchedule", () => {
  it("marks an obligation past its date as lapsed", () => {
    const [entry] = buildSchedule([note({ id: "A", due: "2026-07-01" })], OPTIONS);
    expect(entry?.state).toBe("lapsed");
    expect(entry?.inDays).toBe(-53);
    expect(entry?.alerting).toBe(true);
  });

  it("treats a one-off event in the past as history, not an alarm", () => {
    // Only obligations lapse. That distinction is why there are two types.
    const past = parseEventNote("60 Events/E.md", { type: "event", due: "2026-07-01" });
    const [entry] = buildSchedule([past], OPTIONS);
    expect(entry?.state).toBe("passed");
    expect(entry?.alerting).toBe(false);
  });

  it("fires the tightest lead time that has been reached", () => {
    // 90/30/7 with 20 days to go: the 30-day reminder is the one that has just
    // fired. Reporting 90 would understate how close this now is.
    const n = note({ id: "A", due: "2026-09-12", lead_days: [90, 30, 7] });
    const [entry] = buildSchedule([n], OPTIONS);
    expect(entry?.inDays).toBe(20);
    expect(entry?.leadFired).toBe(30);
    expect(entry?.state).toBe("soon");
  });

  it("falls back to the configured lead times when the note declares none", () => {
    const [entry] = buildSchedule([note({ id: "A", due: "2026-09-15" })], OPTIONS);
    expect(entry?.leadDays).toEqual([30, 7, 1]);
    expect(entry?.leadFired).toBe(30);
  });

  it("calls the day itself 'today'", () => {
    const [entry] = buildSchedule([note({ id: "A", due: TODAY })], OPTIONS);
    expect(entry?.state).toBe("today");
    expect(entry?.inDays).toBe(0);
  });

  it("separates inside the horizon from beyond it", () => {
    const near = note({ id: "A", due: "2026-10-01", lead_days: [7] });
    const far = note({ id: "B", due: "2027-06-01", lead_days: [7] });
    const schedule = buildSchedule([near, far], OPTIONS);
    expect(schedule.map((e) => e.state)).toEqual(["upcoming", "far"]);
    expect(schedule.map((e) => e.withinHorizon)).toEqual([true, false]);
  });

  it("raises an obligation nothing can date, rather than dropping it", () => {
    // §5.7's real failure mode: not the late obligation, the unwatched one.
    const blind = note({ id: "A", recurrence: { every: 1, unit: "year" } });
    const [entry] = buildSchedule([blind], OPTIONS);
    expect(entry?.state).toBe("unscheduled");
    expect(entry?.alerting).toBe(true);
  });

  it("does not raise an alarm for an undated one-off event", () => {
    const undated = parseEventNote("60 Events/E.md", { type: "event", title: "Someday" });
    const [entry] = buildSchedule([undated], OPTIONS);
    expect(entry?.state).toBe("unscheduled");
    expect(entry?.alerting).toBe(false);
  });

  it("puts lapsed first, worst first, whatever order they arrive in", () => {
    const schedule = buildSchedule(
      [
        note({ id: "soon", due: "2026-09-01" }),
        note({ id: "late", due: "2026-05-01" }),
        note({ id: "blind", recurrence: { every: 1, unit: "year" } }),
        note({ id: "later", due: "2026-07-01" }),
      ],
      OPTIONS,
    );
    expect(schedule.map((e) => e.note.id)).toEqual(["late", "later", "blind", "soon"]);
  });
});

describe("alerts", () => {
  const schedule = buildSchedule(
    [
      note({ id: "late", due: "2026-05-01" }),
      note({ id: "today", due: TODAY }),
      note({ id: "soon", due: "2026-09-01" }),
      note({ id: "quiet", due: "2027-01-01" }),
    ],
    OPTIONS,
  );

  it("counts only what wants attention now", () => {
    expect(alertingCount(schedule)).toBe(3);
  });

  it("names the lapsed ones for the alarm", () => {
    expect(lapsed(schedule).map((e) => e.note.id)).toEqual(["late"]);
  });

  it("summarises in one line", () => {
    expect(describeAlerts(schedule)).toBe("1 lapsed, 1 due today, 1 coming up");
  });

  it("says nothing when nothing is up", () => {
    expect(describeAlerts(buildSchedule([note({ id: "quiet", due: "2027-01-01" })], OPTIONS))).toBe("");
  });
});

describe("leadDates", () => {
  it("gives the day each reminder falls on", () => {
    const [entry] = buildSchedule([note({ id: "A", due: "2026-09-15", lead_days: [30, 7] })], OPTIONS);
    expect(leadDates(entry!)).toEqual(["2026-08-16", "2026-09-08"]);
  });

  it("gives none for something already lapsed", () => {
    const [entry] = buildSchedule([note({ id: "A", due: "2026-01-01" })], OPTIONS);
    expect(leadDates(entry!)).toEqual([]);
  });
});

describe("materialisePlan", () => {
  it("offers a date for a note that has none", () => {
    const n = note({ id: "A", recurrence: { every: 2, unit: "year", anchor: "2025-11-01" }, last_completed: "2025-11-01" });
    expect(materialisePlan([n])).toEqual([{ note: n, from: "", to: "2027-11-01" }]);
  });

  it("leaves a note whose written date is still the right one alone", () => {
    const n = note({
      id: "A",
      due: "2026-09-15",
      last_completed: "2025-09-12",
      recurrence: { every: 1, unit: "year", anchor: "2026-09-15" },
    });
    expect(materialisePlan([n])).toEqual([]);
  });

  it("offers to move a date the rule has overtaken", () => {
    const n = note({
      id: "A",
      due: "2026-03-31",
      last_completed: "2026-03-31",
      recurrence: { every: 1, unit: "year", anchor: "2026-03-31" },
    });
    expect(materialisePlan([n])).toEqual([{ note: n, from: "2026-03-31", to: "2027-03-31" }]);
  });

  it("ignores anything with no recurrence rule", () => {
    expect(materialisePlan([note({ id: "A", due: "2026-09-15" })])).toEqual([]);
  });
});

describe("completion", () => {
  it("advances to the next occurrence", () => {
    const n = note({
      id: "A",
      due: "2026-09-15",
      recurrence: { every: 1, unit: "year", anchor: "2026-09-15" },
    });
    expect(completion(n, "2026-09-15")).toEqual({
      lastCompleted: "2026-09-15",
      next: "2027-09-15",
    });
  });

  it("does not hand back the occurrence just completed early", () => {
    // Finishing a review five days early must not reschedule it for five days
    // from now — that is how a year gets skipped.
    const n = note({
      id: "A",
      due: "2026-09-15",
      recurrence: { every: 1, unit: "year", anchor: "2026-09-15" },
    });
    expect(completion(n, "2026-09-10").next).toBe("2027-09-15");
  });

  it("counts a late completion from the occurrence, not the day it was done", () => {
    const n = note({
      id: "A",
      due: "2026-03-31",
      recurrence: { every: 1, unit: "year", anchor: "2026-03-31" },
    });
    expect(completion(n, "2026-04-20").next).toBe("2027-03-31");
  });

  it("gives a one-off no new date", () => {
    const once = parseEventNote("60 Events/E.md", { type: "event", due: "2026-09-01" });
    expect(completion(once, TODAY)).toEqual({ lastCompleted: TODAY, next: "" });
  });
});
