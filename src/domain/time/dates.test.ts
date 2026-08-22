import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  daysBetween,
  formatDuration,
  isTimestamp,
  parseTimestamp,
  toVaultDate,
  toVaultMinute,
  toVaultMonth,
} from "./dates";

describe("parseTimestamp", () => {
  it("reads a bare date as UTC midnight", () => {
    expect(parseTimestamp("2026-07-14")).toBe(Date.UTC(2026, 6, 14));
  });

  it("agrees with a YAML-parsed Date for the same bare date", () => {
    // js-yaml turns an unquoted `2026-07-14` into a Date at UTC midnight. If
    // the string path disagreed, dwell times would shift by a timezone offset
    // depending on how the note happened to be read.
    expect(parseTimestamp(new Date("2026-07-14"))).toBe(parseTimestamp("2026-07-14"));
  });

  it("reads an offsetless date-time as local", () => {
    expect(parseTimestamp("2026-07-14T09:12")).toBe(new Date(2026, 6, 14, 9, 12).getTime());
  });

  it("honours an explicit offset", () => {
    expect(parseTimestamp("2026-07-14T09:12:00Z")).toBe(Date.UTC(2026, 6, 14, 9, 12));
    expect(parseTimestamp("2026-07-14T17:12:00+08:00")).toBe(Date.UTC(2026, 6, 14, 9, 12));
    expect(parseTimestamp("2026-07-14T17:12:00+0800")).toBe(Date.UTC(2026, 6, 14, 9, 12));
  });

  it("accepts a space separator, seconds and fractions", () => {
    expect(parseTimestamp("2026-07-14 09:12")).toBe(parseTimestamp("2026-07-14T09:12"));
    expect(parseTimestamp("2026-07-14T09:12:30Z")).toBe(Date.UTC(2026, 6, 14, 9, 12, 30));
    expect(parseTimestamp("2026-07-14T09:12:30.500Z")).toBe(Date.UTC(2026, 6, 14, 9, 12, 30, 500));
  });

  it("refuses anything it cannot read rather than guessing", () => {
    for (const bad of [
      "",
      "   ",
      "not a date",
      "2026",
      "2026-07",
      "14/07/2026",
      "2026-02-30", // does not exist
      "2026-13-01",
      "[[Dr A Tan]]",
      null,
      undefined,
      true,
      {},
      [],
      NaN,
      new Date("nope"),
    ]) {
      expect(parseTimestamp(bad)).toBeNull();
    }
    expect(isTimestamp("2026-07-14")).toBe(true);
    expect(isTimestamp("soon")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTimestamp("  2026-07-14  ")).toBe(Date.UTC(2026, 6, 14));
  });
});

describe("vault formatting", () => {
  it("writes local dates, minutes and months", () => {
    const t = new Date(2026, 6, 14, 14, 3).getTime();
    expect(toVaultDate(t)).toBe("2026-07-14");
    expect(toVaultMinute(t)).toBe("2026-07-14T14:03");
    expect(toVaultMonth(t)).toBe("2026-07");
  });

  it("zero-pads single-digit months, days, hours and minutes", () => {
    const t = new Date(2026, 0, 5, 9, 7).getTime();
    expect(toVaultMinute(t)).toBe("2026-01-05T09:07");
  });
});

describe("formatDuration", () => {
  it("scales from minutes to days", () => {
    expect(formatDuration(30_000)).toBe("under a minute");
    expect(formatDuration(MINUTE_MS)).toBe("1 minute");
    expect(formatDuration(45 * MINUTE_MS)).toBe("45 minutes");
    expect(formatDuration(HOUR_MS)).toBe("1 hour");
    expect(formatDuration(47 * HOUR_MS)).toBe("47 hours");
    expect(formatDuration(2 * DAY_MS)).toBe("2 days");
    expect(formatDuration(23 * DAY_MS)).toBe("23 days");
    expect(formatDuration(412 * DAY_MS)).toBe("412 days");
  });

  it("reports magnitude for negative durations", () => {
    expect(formatDuration(-23 * DAY_MS)).toBe("23 days");
  });

  it("does not pretend to know an unreadable duration", () => {
    expect(formatDuration(NaN)).toBe("unknown");
    expect(formatDuration(Infinity)).toBe("unknown");
  });
});

describe("daysBetween", () => {
  it("counts whole elapsed days", () => {
    const from = Date.UTC(2026, 6, 14);
    expect(daysBetween(from, from)).toBe(0);
    expect(daysBetween(from, from + DAY_MS - 1)).toBe(0);
    expect(daysBetween(from, from + DAY_MS)).toBe(1);
    expect(daysBetween(from, from + 21 * DAY_MS)).toBe(21);
  });

  it("crosses a year boundary", () => {
    expect(daysBetween(Date.UTC(2025, 11, 25), Date.UTC(2026, 0, 5))).toBe(11);
  });
});
