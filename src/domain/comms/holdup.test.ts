import { describe, expect, it } from "vitest";
import { breachedIn, describeHoldup, mergeHoldup } from "./holdup";
import { partiesIn } from "./party";
import { agedOutreach, groupOutreachByParty, type Thread } from "./thread";
import { groupByBlockingParty, type RequestView } from "../request/holdup";
import type { RequestMetrics } from "../request/dwell";
import type { RequestNote } from "../request/request";
import { DAY_MS } from "../time/dates";

const NOW = Date.parse("2026-08-23T09:00:00Z");
const day = (n: number) => NOW - n * DAY_MS;

function view(overrides: {
  id: string;
  blockedOn: string;
  blockedForMs?: number;
  breached?: boolean;
}): RequestView {
  const request = { uid: `uid-${overrides.id}`, id: overrides.id, title: "A cohort" } as RequestNote;
  const metrics = {
    completed: false,
    totalAgeMs: 30 * DAY_MS,
    blockedOn: overrides.blockedOn,
    blockedForMs: overrides.blockedForMs ?? 10 * DAY_MS,
    stageSla: { state: overrides.breached === true ? "breached" : "on-track" },
    dueSla: { state: "no-target" },
    problems: [],
  } as unknown as RequestMetrics;
  return { request, metrics };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    uid: "u",
    id: "THR-2026-0001",
    channel: "email",
    subject: "RE: cohort",
    threadKey: "",
    with: partiesIn(["[[Dr A Tan]]"]),
    requests: [],
    directionLast: "outbound",
    lastOutbound: day(9),
    lastInbound: null,
    awaiting: "them",
    state: "open",
    messages: [],
    raw: {},
    ...overrides,
  };
}

const merge = (views: RequestView[], threads: Thread[]) =>
  mergeHoldup(
    groupByBlockingParty(views),
    groupOutreachByParty(agedOutreach(threads, { now: NOW })),
  );

describe("mergeHoldup", () => {
  it("puts one person's requests and messages on one row", () => {
    // The bug this exists for: two adjacent headings with the same name, where
    // the reader acts on the first and never sees the second.
    const people = merge([view({ id: "R1", blockedOn: "[[Dr A Tan]]" })], [thread()]);
    expect(people).toHaveLength(1);
    expect(people[0]?.views).toHaveLength(1);
    expect(people[0]?.threads).toHaveLength(1);
  });

  it("merges across the spellings of one person", () => {
    const people = merge(
      [view({ id: "R1", blockedOn: "[[30 People/Dr A Tan|Tan]]" })],
      [thread({ with: partiesIn(["[[Dr A Tan]]"]) })],
    );
    expect(people).toHaveLength(1);
    expect(people[0]?.party.name).toBe("Dr A Tan");
  });

  it("keeps somebody who only has unanswered outreach", () => {
    const people = merge([], [thread({ with: partiesIn(["[[Dr B Lim]]"]) })]);
    expect(people.map((person) => person.party.name)).toEqual(["Dr B Lim"]);
    expect(people[0]?.views).toEqual([]);
  });

  it("keeps somebody who only has requests", () => {
    const people = merge([view({ id: "R1", blockedOn: "[[Dr C Ng]]" })], []);
    expect(people[0]?.threads).toEqual([]);
  });

  it("takes the longest wait from whichever source is worse", () => {
    const people = merge(
      [view({ id: "R1", blockedOn: "[[Dr A Tan]]", blockedForMs: 2 * DAY_MS })],
      [thread({ lastOutbound: day(40) })],
    );
    expect(people[0]?.longestMs).toBe(40 * DAY_MS);
  });

  it("ranks a breached request above a longer-unanswered message", () => {
    // A breach is a commitment already missed; an unanswered email is a
    // courtesy overdue. They are not the same thing.
    const people = merge(
      [
        view({ id: "R1", blockedOn: "[[Late]]", blockedForMs: DAY_MS, breached: true }),
        view({ id: "R2", blockedOn: "[[Quiet]]", blockedForMs: DAY_MS }),
      ],
      [thread({ with: partiesIn(["[[Quiet]]"]), lastOutbound: day(200) })],
    );
    expect(people.map((person) => person.party.name)).toEqual(["Late", "Quiet"]);
  });

  it("orders by the longest wait when nobody has breached", () => {
    const people = merge(
      [
        view({ id: "R1", blockedOn: "[[Short]]", blockedForMs: 3 * DAY_MS }),
        view({ id: "R2", blockedOn: "[[Long]]", blockedForMs: 30 * DAY_MS }),
      ],
      [],
    );
    expect(people.map((person) => person.party.name)).toEqual(["Long", "Short"]);
  });

  it("is empty when nothing is waiting on anybody", () => {
    expect(merge([], [])).toEqual([]);
  });

  it("keeps the raw reference, so the chase-up button can address them", () => {
    const people = merge([view({ id: "R1", blockedOn: "[[30 People/Dr A Tan|Tan]]" })], []);
    expect(people[0]?.party.raw).toBe("[[30 People/Dr A Tan|Tan]]");
  });
});

describe("describeHoldup", () => {
  it("names both sources, and omits whichever is empty", () => {
    const both = merge([view({ id: "R1", blockedOn: "[[Dr A Tan]]" })], [thread()])[0]!;
    expect(describeHoldup(both)).toBe("1 request · 1 unanswered message");

    const requestsOnly = merge(
      [
        view({ id: "R1", blockedOn: "[[Dr C Ng]]" }),
        view({ id: "R2", blockedOn: "[[Dr C Ng]]" }),
      ],
      [],
    )[0]!;
    expect(describeHoldup(requestsOnly)).toBe("2 requests");

    const outreachOnly = merge([], [thread()])[0]!;
    expect(describeHoldup(outreachOnly)).toBe("1 unanswered message");
  });
});

describe("breachedIn", () => {
  it("counts breached requests and nothing else", () => {
    expect(
      breachedIn([
        view({ id: "a", blockedOn: "[[X]]", breached: true }),
        view({ id: "b", blockedOn: "[[X]]" }),
      ]),
    ).toBe(1);
  });
});
