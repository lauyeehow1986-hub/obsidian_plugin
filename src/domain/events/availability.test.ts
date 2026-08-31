/**
 * Spotting a calendar file that carries no titles.
 *
 * From a real report: importing an Outlook calendar produced event notes with
 * no meeting titles, which looked exactly like a parser dropping `SUMMARY`. It
 * was not. The export had been saved at Outlook's default detail level,
 * **Availability only**, which sets every `SUMMARY` to the entry's free/busy
 * word and omits `DESCRIPTION`, `LOCATION`, `ORGANIZER` and `ATTENDEE`
 * entirely. The titles were never in the file.
 *
 * The parser was correct and the import was faithful, so there is nothing to
 * fix in either — but silence sent someone hunting through working code, and
 * the real fix is a thirty-second re-export. Hence a warning.
 */

import { describe, expect, it } from "vitest";
import { availabilityOnly } from "./ics";
import type { ParsedIcsEvent } from "./ics";

function event(summary: string): ParsedIcsEvent {
  return {
    uid: "040000008200E00074C5B7@example",
    summary,
    description: "",
    location: "",
    date: "2026-09-01",
    startTime: "09:00",
    endTime: "10:00",
    allDay: false,
  };
}

describe("detecting an availability-only calendar export", () => {
  it("spots a file where every entry is a free/busy word", () => {
    // The shape of the real file: four entries, all named "Tentative", each
    // matching its own X-MICROSOFT-CDO-BUSYSTATUS.
    expect(availabilityOnly([event("Tentative"), event("Tentative")])).toBe(true);
  });

  it("covers the other words Outlook substitutes", () => {
    for (const word of ["Busy", "Free", "Private", "Out of Office", "Working Elsewhere"]) {
      expect(availabilityOnly([event(word)]), word).toBe(true);
    }
  });

  it("ignores case and surrounding space, because exporters vary", () => {
    expect(availabilityOnly([event("  busy  "), event("BUSY")])).toBe(true);
  });

  it("treats an entry with no summary at all as carrying no title", () => {
    expect(availabilityOnly([event(""), event("Busy")])).toBe(true);
  });

  it("stays quiet when any entry has a real title", () => {
    // The warning must not fire on a normal export that happens to contain one
    // meeting somebody called "Free". One real title proves detail is present.
    expect(availabilityOnly([event("Busy"), event("HF service MDT")])).toBe(false);
  });

  it("stays quiet on a normal full-details export", () => {
    expect(availabilityOnly([event("Echo lab handover"), event("Grant deadline")])).toBe(false);
  });

  it("says nothing about an empty file", () => {
    // Nothing was imported, so there is nothing to explain; the caller already
    // reports "no calendar entries found".
    expect(availabilityOnly([])).toBe(false);
  });
});
