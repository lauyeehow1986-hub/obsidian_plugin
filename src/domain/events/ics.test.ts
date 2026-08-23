import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  escapeText,
  foldLine,
  parseCalendar,
  toIcsDate,
  toIcsStamp,
  type IcsEvent,
} from "./ics";

const NOW = Date.UTC(2026, 7, 23, 10, 15, 0);

function event(extra: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "01J8Z3QK7M2R@scdb-cockpit",
    date: "2026-09-15",
    summary: "OBL-2026-001 — Continuing review",
    description: "Study suspended if the review lapses.",
    alarms: [30, 7],
    categories: ["SCDB", "obligation"],
    ...extra,
  };
}

/** Content lines as a reader sees them: unfolded, CRLF split. */
function lines(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter((line) => line !== "");
}

describe("escapeText", () => {
  it("escapes what RFC 5545 §3.3.11 requires, and in the right order", () => {
    expect(escapeText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });

  it("turns real newlines into the literal escape", () => {
    expect(escapeText("one\ntwo\r\nthree")).toBe("one\\ntwo\\nthree");
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds at 75 octets with a leading space on the continuation", () => {
    const long = `SUMMARY:${"a".repeat(200)}`;
    const folded = foldLine(long);
    for (const part of folded.split("\r\n")) {
      expect(part.length).toBeLessThanOrEqual(75);
    }
    expect(folded.split("\r\n").slice(1).every((part) => part.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("counts octets, not characters, and never splits one", () => {
    // A line of 40 three-byte characters is 120 octets but only 40 characters.
    // Splitting by index would produce a valid-looking file full of mojibake.
    const long = `SUMMARY:${"中".repeat(40)}`;
    const folded = foldLine(long);
    expect(folded).toContain("\r\n ");
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    for (const part of folded.split("\r\n")) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

describe("toIcsDate and toIcsStamp", () => {
  it("writes the DATE and UTC DATE-TIME forms", () => {
    expect(toIcsDate("2026-09-15")).toBe("20260915");
    expect(toIcsStamp(NOW)).toBe("20260823T101500Z");
  });
});

describe("buildCalendar", () => {
  const text = buildCalendar([event()], { now: NOW, name: "SCDB deadlines" });

  it("wraps the events in a calendar", () => {
    expect(lines(text)[0]).toBe("BEGIN:VCALENDAR");
    expect(lines(text).at(-1)).toBe("END:VCALENDAR");
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("uses CRLF throughout", () => {
    expect(text.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });

  it("writes an all-day event whose DTEND is the following day", () => {
    // DTEND is exclusive for a DATE value; without it some clients draw a
    // zero-length event that never shows in month view.
    expect(lines(text)).toContain("DTSTART;VALUE=DATE:20260915");
    expect(lines(text)).toContain("DTEND;VALUE=DATE:20260916");
  });

  it("marks deadlines free rather than busy", () => {
    expect(lines(text)).toContain("TRANSP:TRANSPARENT");
  });

  it("writes one VALARM per lead time", () => {
    expect(lines(text).filter((line) => line === "BEGIN:VALARM")).toHaveLength(2);
    expect(lines(text)).toContain("TRIGGER:-P30D");
    expect(lines(text)).toContain("TRIGGER:-P7D");
  });

  it("uses a zero-length trigger for an on-the-day reminder", () => {
    // There is no -P0D in RFC 5545's duration grammar.
    const onTheDay = buildCalendar([event({ alarms: [0] })], { now: NOW });
    expect(lines(onTheDay)).toContain("TRIGGER:-PT0S");
  });

  it("omits an empty description rather than writing a blank property", () => {
    // No alarms either: a VALARM carries a DESCRIPTION of its own.
    const bare = buildCalendar([event({ description: "", categories: [], alarms: [] })], {
      now: NOW,
    });
    expect(lines(bare).some((line) => line.startsWith("DESCRIPTION:"))).toBe(false);
    expect(lines(bare).some((line) => line.startsWith("CATEGORIES:"))).toBe(false);
  });

  it("gives every event in one file the same DTSTAMP", () => {
    const two = buildCalendar([event(), event({ uid: "b", date: "2026-10-01" })], { now: NOW });
    expect(lines(two).filter((line) => line.startsWith("DTSTAMP:"))).toEqual([
      "DTSTAMP:20260823T101500Z",
      "DTSTAMP:20260823T101500Z",
    ]);
  });
});

describe("parseCalendar", () => {
  it("round-trips what buildCalendar wrote", () => {
    const text = buildCalendar([event()], { now: NOW });
    const parsed = parseCalendar(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      uid: "01J8Z3QK7M2R@scdb-cockpit",
      summary: "OBL-2026-001 — Continuing review",
      description: "Study suspended if the review lapses.",
      date: "2026-09-15",
      allDay: true,
    });
  });

  it("survives a summary long enough to be folded", () => {
    const summary = `OBL-2026-001 — ${"a very long obligation title ".repeat(6)}`.trim();
    const parsed = parseCalendar(buildCalendar([event({ summary })], { now: NOW }));
    expect(parsed.events[0]?.summary).toBe(summary);
  });

  it("unescapes commas, semicolons and newlines", () => {
    const description = "Renew; then file, and\nnotify the sponsor";
    const parsed = parseCalendar(buildCalendar([event({ description })], { now: NOW }));
    expect(parsed.events[0]?.description).toBe(description);
  });

  it("reads a timed Outlook meeting, keeping the time as written", () => {
    const outlook = [
      "BEGIN:VCALENDAR",
      "PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:GMT Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16011028T020000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:040000008200E00074C5B7101A82E00800000000",
      "DTSTART;TZID=GMT Standard Time:20260915T090000",
      "DTEND;TZID=GMT Standard Time:20260915T100000",
      "SUMMARY:Data governance committee",
      "LOCATION:Meeting room 3",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const parsed = parseCalendar(outlook);
    expect(parsed.problems).toEqual([]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      summary: "Data governance committee",
      location: "Meeting room 3",
      date: "2026-09-15",
      startTime: "09:00",
      endTime: "10:00",
      allDay: false,
    });
  });

  it("does not mistake a VALARM's own DESCRIPTION for the event's", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART;VALUE=DATE:20260915",
      "SUMMARY:Review",
      "BEGIN:VALARM",
      "DESCRIPTION:Reminder text",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseCalendar(text).events[0]?.description).toBe("");
  });

  it("skips an entry with no readable start date and says which", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "SUMMARY:Undated thing",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseCalendar(text);
    expect(parsed.events).toEqual([]);
    expect(parsed.problems[0]).toContain("Undated thing");
  });

  it("refuses to treat something that is not a calendar as one", () => {
    expect(parseCalendar("# Just a note\n\nSome prose.").problems[0]).toContain(
      "does not look like an iCalendar file",
    );
  });

  it("reports an event the file never closed", () => {
    const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "DTSTART;VALUE=DATE:20260915"].join(
      "\r\n",
    );
    expect(parseCalendar(text).problems).toContain(
      "The last event in the file was never closed with END:VEVENT.",
    );
  });

  it("accepts bare LF, which is what a hand-edited file has", () => {
    const text = buildCalendar([event()], { now: NOW }).replace(/\r\n/g, "\n");
    expect(parseCalendar(text).events).toHaveLength(1);
  });
});
