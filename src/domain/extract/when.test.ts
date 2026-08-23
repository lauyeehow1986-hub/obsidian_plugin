import { describe, expect, it } from "vitest";
import { readWhen } from "./when";

/** A Wednesday, so "by Friday" is two days out and "by Wednesday" is seven. */
const WED = "2026-08-19";

describe("readWhen — dates written out in full", () => {
  it("reads an ISO date and lifts it out of the sentence", () => {
    const result = readWhen("countersign the DUA by 2026-09-15", WED);
    expect(result.due).toEqual({ date: "2026-09-15", from: "iso", phrase: "2026-09-15" });
    expect(result.rest).toBe("countersign the DUA");
  });

  it("reads a day-first date and infers the meeting's year", () => {
    const result = readWhen("send the report by 15 Sep", WED);
    expect(result.due?.date).toBe("2026-09-15");
    expect(result.due?.from).toBe("written");
    expect(result.rest).toBe("send the report");
  });

  it("reads a month-first date with an ordinal and a comma", () => {
    expect(readWhen("due September 15th, 2027", WED).due?.date).toBe("2027-09-15");
  });

  it("rolls a bare date forward when the meeting's year puts it long in the past", () => {
    // Said in August about "5 February": February has gone, so it means next year.
    expect(readWhen("submit by 5 Feb", WED).due?.date).toBe("2027-02-05");
  });

  it("leaves a recently-passed date in the past, because overdue is a real state", () => {
    expect(readWhen("chase the 5 August invoice", WED).due?.date).toBe("2026-08-05");
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    const result = readWhen("due 2026-02-30", WED);
    expect(result.due).toBeNull();
    expect(result.problems[0]).toMatch(/not a real date/);
  });
});

describe("readWhen — the ambiguity it refuses", () => {
  it("will not read a slashed numeric date either way", () => {
    const result = readWhen("chase by 03/04/2026", WED);
    expect(result.due).toBeNull();
    expect(result.problems[0]).toMatch(/day-first or month-first/);
  });

  it("says nothing about slashes when a real date was found as well", () => {
    const result = readWhen("per note 3/4, due 2026-09-15", WED);
    expect(result.due?.date).toBe("2026-09-15");
    expect(result.problems).toEqual([]);
  });
});

describe("readWhen — relative to the meeting, never to today", () => {
  it("resolves a weekday forward from the meeting date", () => {
    expect(readWhen("reply by Friday", WED).due).toEqual({
      date: "2026-08-21",
      from: "weekday",
      phrase: "by Friday",
    });
  });

  it("reads the same weekday as the meeting as the one coming, not the one it is", () => {
    expect(readWhen("reply by Wednesday", WED).due?.date).toBe("2026-08-26");
  });

  it("ignores a weekday with no preposition to make it a deadline", () => {
    expect(readWhen("discussed Tuesday's audit findings", WED).due).toBeNull();
  });

  it("reads tomorrow, next week and the end of the month", () => {
    expect(readWhen("chase tomorrow", WED).due?.date).toBe("2026-08-20");
    expect(readWhen("revisit next week", WED).due?.date).toBe("2026-08-26");
    expect(readWhen("close by end of the month", WED).due?.date).toBe("2026-08-31");
  });

  it("reads the end of the week as the Friday coming", () => {
    expect(readWhen("draft by end of week", WED).due?.date).toBe("2026-08-21");
    // Said on a Friday it means that Friday, not a week later.
    expect(readWhen("draft by end of week", "2026-08-21").due?.date).toBe("2026-08-21");
  });

  it("counts a span in days, weeks and spelled numbers", () => {
    expect(readWhen("follow up in 10 days", WED).due?.date).toBe("2026-08-29");
    expect(readWhen("follow up in two weeks", WED).due?.date).toBe("2026-09-02");
    expect(readWhen("respond within 3 days", WED).due?.date).toBe("2026-08-22");
  });

  it("resolves against the minutes, so old minutes do not land in this week", () => {
    expect(readWhen("reply by Friday", "2026-02-25").due?.date).toBe("2026-02-27");
  });
});

describe("readWhen — with no anchor", () => {
  it("still reads a fully written date", () => {
    expect(readWhen("due 2026-09-15", null).due?.date).toBe("2026-09-15");
    expect(readWhen("due 15 September 2026", null).due?.date).toBe("2026-09-15");
  });

  it("refuses a relative date and says what to do about it", () => {
    const result = readWhen("reply by Friday", null);
    expect(result.due).toBeNull();
    expect(result.problems[0]).toMatch(/minutes carry no date/);
  });

  it("refuses a bare day and month, because the year is the missing part", () => {
    const result = readWhen("send by 15 Sep", null);
    expect(result.due).toBeNull();
    expect(result.problems[0]).toMatch(/no year/);
  });
});

describe("readWhen — what is left of the sentence", () => {
  it("takes the preposition with the date", () => {
    expect(readWhen("chase the DUA before 2026-09-15", WED).rest).toBe("chase the DUA");
    expect(readWhen("chase the DUA, due by 2026-09-15", WED).rest).toBe("chase the DUA");
    expect(readWhen("chase the DUA (by Friday)", WED).rest).toBe("chase the DUA");
  });

  it("keeps a full stop and drops a dangling comma", () => {
    expect(readWhen("chase the DUA by 2026-09-15.", WED).rest).toBe("chase the DUA.");
  });

  it("returns the sentence unchanged when there is no date in it", () => {
    expect(readWhen("chase the DUA", WED)).toEqual({
      due: null,
      rest: "chase the DUA",
      problems: [],
    });
  });
});
