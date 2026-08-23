import { describe, expect, it } from "vitest";
import { eventFromCalendar, newObligation, nextEventId, safeFilename } from "./create";
import { parseEventNote } from "./event";
import type { ParsedIcsEvent } from "./ics";

const NOW = Date.UTC(2026, 7, 23, 10, 0, 0);

describe("nextEventId", () => {
  it("continues the year's sequence", () => {
    expect(nextEventId(["OBL-2026-001", "OBL-2026-004"], 2026, "OBL")).toBe("OBL-2026-005");
  });

  it("starts a new year at one", () => {
    expect(nextEventId(["OBL-2026-009"], 2027, "OBL")).toBe("OBL-2027-001");
  });

  it("ignores ids belonging to other prefixes", () => {
    expect(nextEventId(["EVT-2026-007", "REQ-2026-014"], 2026, "OBL")).toBe("OBL-2026-001");
  });
});

describe("safeFilename", () => {
  it("strips what a vault path cannot carry", () => {
    expect(safeFilename('EVT-2026-001 Review: part #2/3', "EVT")).toBe("EVT-2026-001 Review part 2 3");
  });

  it("falls back rather than producing an empty name", () => {
    expect(safeFilename("///", "EVT-2026-001")).toBe("EVT-2026-001");
  });
});

describe("newObligation", () => {
  const built = newObligation({
    id: "OBL-2026-003",
    title: "DSRB continuing review",
    due: "2027-03-31",
    recurrence: { every: 1, unit: "year", anchor: "" },
    leadDays: [90, 30, 7],
    owner: "[[Owner]]",
    study: "[[EuroHeart]]",
    consequence: "Study suspended if the review lapses.",
    now: NOW,
    uid: "01J8Z3QK7M2R",
  });

  it("writes a note the reader understands", () => {
    const note = parseEventNote(`60 Events/${built.filename}`, built.frontmatter);
    expect(note.problems).toEqual([]);
    expect(note.type).toBe("obligation");
    expect(note.due).toBe("2027-03-31");
    expect(note.leadDays).toEqual([90, 30, 7]);
  });

  it("seeds a missing anchor from the due date", () => {
    // A rule with nothing to count from is the one thing §5.7 cannot work with,
    // and the date the user just typed is the obvious answer.
    expect(built.frontmatter["recurrence"]).toEqual({
      every: 1,
      unit: "year",
      anchor: "2027-03-31",
    });
  });

  it("names the file after the id", () => {
    expect(built.filename).toBe("OBL-2026-003.md");
  });

  it("writes a one-off as an event, with no recurrence bookkeeping", () => {
    const once = newObligation({
      id: "EVT-2026-001",
      title: "Submission deadline",
      due: "2026-11-01",
      recurrence: null,
      leadDays: [7],
      owner: "",
      study: "",
      consequence: "",
      now: NOW,
    });
    expect(once.frontmatter["type"]).toBe("event");
    expect(once.frontmatter).not.toHaveProperty("recurrence");
    expect(once.frontmatter).not.toHaveProperty("last_completed");
  });
});

describe("eventFromCalendar", () => {
  function parsed(extra: Partial<ParsedIcsEvent> = {}): ParsedIcsEvent {
    return {
      uid: "040000008200E00074C5B7@outlook",
      summary: "Data governance committee",
      description: "Standing monthly meeting.",
      location: "Meeting room 3",
      date: "2026-09-15",
      startTime: "09:00",
      endTime: "10:00",
      allDay: false,
      ...extra,
    };
  }

  it("becomes an event note carrying the calendar uid", () => {
    const imported = eventFromCalendar(parsed(), { now: NOW, existingIds: [], uid: "01J" })!;
    expect(imported.icsUid).toBe("040000008200E00074C5B7@outlook");
    expect(imported.note.frontmatter).toMatchObject({
      type: "event",
      id: "EVT-2026-001",
      due: "2026-09-15",
      starts: "2026-09-15T09:00",
      ends: "2026-09-15T10:00",
      ics_uid: "040000008200E00074C5B7@outlook",
      source: "calendar-import",
    });
  });

  it("never imports as an obligation", () => {
    // An Outlook RRULE is a different model from §5.7's. Guessing one would
    // produce an obligation whose next occurrence nobody checked.
    const imported = eventFromCalendar(parsed(), { now: NOW, existingIds: [] })!;
    expect(imported.note.frontmatter["type"]).toBe("event");
    expect(imported.note.frontmatter).not.toHaveProperty("recurrence");
  });

  it("leaves the clock off an all-day entry", () => {
    const imported = eventFromCalendar(parsed({ allDay: true, startTime: "" }), {
      now: NOW,
      existingIds: [],
    })!;
    expect(imported.note.frontmatter).not.toHaveProperty("starts");
  });

  it("puts the calendar's own prose in the body, not the frontmatter", () => {
    const imported = eventFromCalendar(parsed(), { now: NOW, existingIds: [] })!;
    expect(imported.note.body).toContain("Standing monthly meeting.");
    expect(imported.note.frontmatter).not.toHaveProperty("description");
  });

  it("gives an untitled entry a name rather than an empty one", () => {
    const imported = eventFromCalendar(parsed({ summary: "" }), { now: NOW, existingIds: [] })!;
    expect(imported.note.frontmatter["title"]).toBe("(untitled calendar entry)");
  });

  it("refuses an unreadable date", () => {
    expect(eventFromCalendar(parsed({ date: "2026-02-30" }), { now: NOW, existingIds: [] })).toBeNull();
  });

  it("numbers by the event's own year, not today's", () => {
    const imported = eventFromCalendar(parsed({ date: "2027-01-05" }), {
      now: NOW,
      existingIds: ["EVT-2027-002"],
    })!;
    expect(imported.note.frontmatter["id"]).toBe("EVT-2027-003");
  });
});
