import { describe, expect, it } from "vitest";
import { parseParty, partiesIn, samePerson } from "./party";
import {
  agedOutreach,
  deriveAwaiting,
  groupOutreachByParty,
  parseThread,
  threadsForRequest,
  type Thread,
} from "./thread";
import { DAY_MS } from "../time/dates";

const NOW = Date.parse("2026-07-24T10:00:00Z");
const day = (n: number) => NOW - n * DAY_MS;

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    uid: "01JZR5B1QK4N8ZXC6TFHJD2VWM",
    id: "THR-2026-0091",
    channel: "email",
    subject: "RE: cohort",
    threadKey: "",
    with: partiesIn(["[[Dr A Tan]]"]),
    requests: ["[[REQ-2026-014]]"],
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

describe("parseParty", () => {
  it("reduces every spelling of one person to one key", () => {
    // The agenda groups across requests and threads; if these three do not
    // agree, "everything Dr Tan is holding up" quietly shows a third of it.
    const keys = ["[[Dr A Tan]]", "[[30 People/Dr A Tan]]", "[[30 People/Dr A Tan|Tan]]"].map(
      (value) => parseParty(value).key,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("dr a tan");
  });

  it("keeps the raw text so the note is never rewritten", () => {
    expect(parseParty("[[30 People/Dr A Tan|Tan]]").raw).toBe("[[30 People/Dr A Tan|Tan]]");
    expect(parseParty("[[30 People/Dr A Tan|Tan]]").name).toBe("Dr A Tan");
  });

  it("strips a heading or block reference from the target", () => {
    expect(parseParty("[[Dr A Tan#Contact]]").name).toBe("Dr A Tan");
  });

  it("takes a plain string at face value", () => {
    // `blocked_on: IT helpdesk` is a legitimate thing to write.
    expect(parseParty("IT helpdesk").name).toBe("IT helpdesk");
    expect(samePerson("IT helpdesk", "it helpdesk")).toBe(true);
  });

  it("de-duplicates a list", () => {
    expect(partiesIn(["[[Dr A Tan]]", "[[30 People/Dr A Tan]]"])).toHaveLength(1);
    expect(partiesIn("[[Dr A Tan]]")).toHaveLength(1);
    expect(partiesIn([1, null, "", "[[X]]"])).toHaveLength(1);
    expect(partiesIn(undefined)).toEqual([]);
  });
});

describe("parseThread", () => {
  it("reads the fields the holdup view depends on", () => {
    const { thread: parsed, problems } = parseThread(
      {
        uid: "01JZR5B1QK4N8ZXC6TFHJD2VWM",
        id: "THR-2026-0091",
        channel: "email",
        subject: "RE: 30-day readmission cohort",
        with: ["[[Dr A Tan]]"],
        requests: ["[[REQ-2026-014]]"],
        last_outbound: "2026-07-22",
        awaiting: "them",
        state: "open",
      },
      "fallback",
    );
    expect(problems).toEqual([]);
    expect(parsed.awaiting).toBe("them");
    expect(parsed.with[0]?.name).toBe("Dr A Tan");
    expect(parsed.lastOutbound).not.toBeNull();
  });

  it("falls back to the filename when there is no id", () => {
    expect(parseThread({}, "THR-2026-0007").thread.id).toBe("THR-2026-0007");
  });

  it("says so when a closed vocabulary is not honoured, and carries on", () => {
    const { thread: parsed, problems } = parseThread(
      { with: ["[[X]]"], channel: "carrier pigeon", state: "maybe", awaiting: "someone" },
      "x",
    );
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("carrier pigeon");
    expect(problems.join(" ")).toContain("`state: maybe`");
    expect(problems.join(" ")).toContain("`awaiting: someone`");
    expect(parsed.channel).toBe("email");
    expect(parsed.state).toBe("open");
  });

  it("flags a thread that names nobody", () => {
    // It cannot appear in the holdup view, which is the reason the note exists.
    expect(parseThread({ id: "T" }, "x").problems.join(" ")).toContain("names nobody");
  });

  it("sorts messages chronologically and puts undated ones last", () => {
    const { thread: parsed } = parseThread(
      {
        with: ["[[X]]"],
        messages: [
          { at: "2026-07-22T14:05", dir: "outbound", summary: "second" },
          { dir: "inbound", summary: "no date" },
          { at: "2026-07-20T09:00", dir: "outbound", summary: "first" },
        ],
      },
      "x",
    );
    expect(parsed.messages.map((m) => m.summary)).toEqual(["first", "second", "no date"]);
  });

  it("keeps composed_only exactly as recorded", () => {
    // §5.11 rule 6: this flag is the honest bit. It must not be inferred.
    const { thread: parsed } = parseThread(
      { with: ["[[X]]"], messages: [{ at: "2026-07-22", dir: "outbound", composed_only: true }] },
      "x",
    );
    expect(parsed.messages[0]?.composedOnly).toBe(true);
  });

  it("reports a messages key that is not a list rather than silently ignoring it", () => {
    expect(parseThread({ with: ["[[X]]"], messages: "lots" }, "x").problems[0]).toContain(
      "not a list",
    );
  });
});

describe("deriveAwaiting", () => {
  it("is only a fallback, and reads the dates the obvious way", () => {
    expect(deriveAwaiting(null, null)).toBe("nobody");
    expect(deriveAwaiting(day(3), null)).toBe("them");
    expect(deriveAwaiting(null, day(3))).toBe("me");
    expect(deriveAwaiting(day(5), day(2))).toBe("me");
    expect(deriveAwaiting(day(2), day(5))).toBe("them");
  });

  it("gives way to the declared field, which may know better", () => {
    // A reply that arrived by phone leaves last_inbound empty; the human who
    // typed `awaiting: me` is right and the dates are not.
    const { thread: parsed } = parseThread(
      { with: ["[[X]]"], last_outbound: "2026-07-22", awaiting: "me" },
      "x",
    );
    expect(parsed.awaiting).toBe("me");
  });
});

describe("agedOutreach", () => {
  it("surfaces an unanswered message past the chase interval", () => {
    const aged = agedOutreach([thread()], { now: NOW });
    expect(aged).toHaveLength(1);
    expect(aged[0]?.waitingDays).toBe(9);
    expect(aged[0]?.overdue).toBe(true);
  });

  it("leaves a fresh thread alone unless asked for the full list", () => {
    const fresh = thread({ lastOutbound: day(2) });
    expect(agedOutreach([fresh], { now: NOW })).toHaveLength(0);
    expect(agedOutreach([fresh], { now: NOW, includeFresh: true })).toHaveLength(1);
  });

  it("respects a configured interval", () => {
    const t = thread({ lastOutbound: day(4) });
    expect(agedOutreach([t], { now: NOW, chaseDays: 3 })).toHaveLength(1);
    expect(agedOutreach([t], { now: NOW, chaseDays: 14 })).toHaveLength(0);
  });

  it("drops threads where the ball is not with them", () => {
    expect(agedOutreach([thread({ awaiting: "me" })], { now: NOW })).toHaveLength(0);
    expect(agedOutreach([thread({ awaiting: "nobody" })], { now: NOW })).toHaveLength(0);
    expect(agedOutreach([thread({ state: "answered" })], { now: NOW })).toHaveLength(0);
    expect(agedOutreach([thread({ state: "closed" })], { now: NOW })).toHaveLength(0);
  });

  it("keeps an undated thread rather than losing it", () => {
    // Silently dropping the one thread whose dates are missing is how a
    // chase-up gets forgotten.
    const aged = agedOutreach([thread({ lastOutbound: null })], { now: NOW });
    expect(aged).toHaveLength(1);
    expect(aged[0]?.waitingMs).toBeNull();
    expect(aged[0]?.overdue).toBe(false);
  });

  it("sorts longest wait first, undated last", () => {
    const aged = agedOutreach(
      [
        thread({ id: "b", lastOutbound: day(8) }),
        thread({ id: "none", lastOutbound: null }),
        thread({ id: "a", lastOutbound: day(30) }),
      ],
      { now: NOW },
    );
    expect(aged.map((entry) => entry.thread.id)).toEqual(["a", "b", "none"]);
  });
});

describe("groupOutreachByParty", () => {
  it("puts one person's unanswered threads together, worst wait first", () => {
    const aged = agedOutreach(
      [
        thread({ id: "t1", with: partiesIn(["[[Dr A Tan]]"]), lastOutbound: day(9) }),
        thread({ id: "t2", with: partiesIn(["[[30 People/Dr A Tan]]"]), lastOutbound: day(20) }),
        thread({ id: "t3", with: partiesIn(["[[Dr B Lim]]"]), lastOutbound: day(10) }),
      ],
      { now: NOW },
    );
    const groups = groupOutreachByParty(aged);
    expect(groups.map((g) => g.party.name)).toEqual(["Dr A Tan", "Dr B Lim"]);
    expect(groups[0]?.threads).toHaveLength(2);
  });

  it("lists a thread under every person on it", () => {
    const aged = agedOutreach([thread({ with: partiesIn(["[[A]]", "[[B]]"]) })], { now: NOW });
    expect(groupOutreachByParty(aged)).toHaveLength(2);
  });
});

describe("threadsForRequest", () => {
  it("matches a wikilink, a bare id and a path, ignoring case", () => {
    const threads = [
      thread({ id: "t1", requests: ["[[REQ-2026-014]]"] }),
      thread({ id: "t2", requests: ["REQ-2026-014"] }),
      thread({ id: "t3", requests: ["[[10 Requests/REQ-2026-014|the cohort]]"] }),
      thread({ id: "t4", requests: ["[[REQ-2026-099]]"] }),
    ];
    expect(threadsForRequest(threads, "req-2026-014").map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("matches nothing for an empty id", () => {
    expect(threadsForRequest([thread()], "  ")).toEqual([]);
  });
});
