import { describe, expect, it } from "vitest";
import { isEventType, parseEventNote } from "./event";

const path = "60 Events/OBL-2026-001.md";

function obligation(extra: Record<string, unknown> = {}) {
  return parseEventNote(path, {
    type: "obligation",
    id: "OBL-2026-001",
    title: "Continuing review",
    due: "2026-09-15",
    recurrence: { every: 1, unit: "year", anchor: "2026-09-15" },
    lead_days: [90, 30, 7],
    consequence: "Study suspended if the review lapses.",
    last_completed: "2025-09-12",
    ...extra,
  });
}

describe("parseEventNote", () => {
  it("reads the shape §5.7 documents", () => {
    const note = obligation();
    expect(note.problems).toEqual([]);
    expect(note.recurring).toBe(true);
    expect(note.due).toBe("2026-09-15");
    expect(note.lastCompleted).toBe("2025-09-12");
    expect(note.recurrence).toEqual({ every: 1, unit: "year", anchor: "2026-09-15" });
  });

  it("sorts lead times largest first and drops duplicates", () => {
    // They fire in that order, and [30, 30, 7] is one reminder at 30 days.
    expect(obligation({ lead_days: [7, 30, 30, 90] }).leadDays).toEqual([90, 30, 7]);
  });

  it("falls back to the filename when there is no id", () => {
    const note = parseEventNote("60 Events/DSRB renewal.md", { type: "event", due: "2026-09-01" });
    expect(note.id).toBe("DSRB renewal");
  });

  it("insists an obligation says what breaks", () => {
    // §5.7: a reminder that does not say what breaks gets ignored.
    expect(obligation({ consequence: "" }).problems).toContain(
      "§5.7 requires `consequence` — say what breaks if this lapses.",
    );
  });

  it("does not demand a consequence from a one-off event", () => {
    const note = parseEventNote("60 Events/E.md", { type: "event", due: "2026-09-01" });
    expect(note.problems).toEqual([]);
  });

  it("reports an unreadable due date instead of dropping it", () => {
    const note = obligation({ due: "September" });
    expect(note.due).toBe("");
    expect(note.problems).toContain("`due` is not a readable date, so this is not being watched.");
  });

  it("reports an unreadable completion date", () => {
    expect(obligation({ last_completed: "last year" }).problems).toContain(
      "`last_completed` is not a readable date and is being ignored.",
    );
  });

  it("reports a rule with nothing to count from", () => {
    const note = obligation({ recurrence: { every: 1, unit: "year" }, due: null });
    expect(note.problems).toContain(
      "`recurrence` has no `anchor` and the note has no `due`, so no date can be computed.",
    );
  });

  it("accepts a rule with no anchor when the note has a due date", () => {
    const note = obligation({ recurrence: { every: 1, unit: "year" } });
    expect(note.problems).toEqual([]);
  });

  it("refuses lead times that are not whole days", () => {
    expect(obligation({ lead_days: ["soon", 7] }).problems).toContain(
      "`lead_days` must be a list of whole numbers of days.",
    );
  });

  it("carries the recurrence parser's complaints through", () => {
    expect(obligation({ recurrence: { every: 1, unit: "fortnight" } }).problems).toContain(
      "`recurrence.unit` must be one of day, week, month, year.",
    );
  });

  it("keeps the calendar uid so a re-import can dedupe", () => {
    expect(obligation({ ics_uid: "040000008200E00074C5B7@outlook" }).icsUid).toBe(
      "040000008200E00074C5B7@outlook",
    );
  });
});

describe("isEventType", () => {
  it("covers both note types and nothing else", () => {
    expect(isEventType("event")).toBe(true);
    expect(isEventType("obligation")).toBe(true);
    expect(isEventType("scdb-request")).toBe(false);
  });
});
