import { describe, expect, it } from "vitest";
import { parseEventNote, type EventNote } from "./event";
import { alarmPreview, calendarEvents } from "./feed";
import { buildSchedule } from "./schedule";

const OPTIONS = { today: "2026-08-23", horizonDays: 60, defaultLeadDays: [30, 7, 1] };

function note(extra: Record<string, unknown>): EventNote {
  return parseEventNote(`60 Events/${String(extra["id"] ?? "X")}.md`, {
    type: "obligation",
    consequence: "Study suspended if the review lapses.",
    owner: "[[Owner]]",
    study: "[[EuroHeart]]",
    uid: "01J8Z3QK7M2R",
    ...extra,
  });
}

function feedFor(notes: EventNote[]) {
  return calendarEvents(buildSchedule(notes, OPTIONS));
}

describe("calendarEvents", () => {
  it("carries the id in the summary so the entry ties back to the note", () => {
    const [entry] = feedFor([note({ id: "OBL-2026-001", title: "Continuing review", due: "2026-09-15" })]);
    expect(entry?.summary).toBe("OBL-2026-001 — Continuing review");
  });

  it("keys on the uid, so a moved date updates the entry instead of adding one", () => {
    const [entry] = feedFor([note({ id: "OBL-2026-001", due: "2026-09-15" })]);
    expect(entry?.uid).toBe("01J8Z3QK7M2R@scdb-cockpit");
  });

  it("falls back to the human id when the note has no uid", () => {
    const [entry] = feedFor([note({ id: "OBL-2026-001", due: "2026-09-15", uid: "" })]);
    expect(entry?.uid).toBe("OBL-2026-001@scdb-cockpit");
  });

  it("emits the next occurrence only, never a run of them", () => {
    // §5.7 is explicit, and a calendar holding every future annual review is
    // one nobody reads.
    const entries = feedFor([
      note({ id: "A", recurrence: { every: 1, unit: "year", anchor: "2026-09-15" } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toBe("2026-09-15");
  });

  it("says what breaks, because §5.7 requires the note to", () => {
    const [entry] = feedFor([note({ id: "A", due: "2026-09-15" })]);
    expect(entry?.description).toContain("Study suspended if the review lapses.");
  });

  it("unwraps wikilinks, which mean nothing outside the vault", () => {
    const [entry] = feedFor([note({ id: "A", due: "2026-09-15" })]);
    expect(entry?.description).toContain("Owner: Owner");
    expect(entry?.description).toContain("Study: EuroHeart");
    expect(entry?.description).not.toContain("[[");
  });

  it("says the vault is not the system of record", () => {
    const [entry] = feedFor([note({ id: "A", due: "2026-09-15" })]);
    expect(entry?.description).toContain("not the system of record");
  });

  it("leaves a lapsed obligation in the file but strips its alarms", () => {
    // The entry belongs in the calendar; an alarm dated in the past would fire
    // on import and keep firing.
    const [entry] = feedFor([note({ id: "A", due: "2026-01-01" })]);
    expect(entry?.date).toBe("2026-01-01");
    expect(entry?.alarms).toEqual([]);
  });

  it("drops a one-off event that has already happened", () => {
    const past = parseEventNote("60 Events/E.md", { type: "event", due: "2026-01-01" });
    expect(feedFor([past])).toEqual([]);
  });

  it("skips anything with no date at all", () => {
    expect(feedFor([note({ id: "A", recurrence: { every: 1, unit: "year" } })])).toEqual([]);
  });

  it("uses the note's own lead times as alarms", () => {
    const [entry] = feedFor([note({ id: "A", due: "2026-09-15", lead_days: [90, 30, 7] })]);
    expect(entry?.alarms).toEqual([90, 30, 7]);
  });
});

describe("alarmPreview", () => {
  it("names the days the reminders will land on", () => {
    const [occurrence] = buildSchedule([note({ id: "A", due: "2026-09-15", lead_days: [30, 7] })], OPTIONS);
    expect(alarmPreview(occurrence!)).toEqual(["2026-08-16", "2026-09-08"]);
  });
});
