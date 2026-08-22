import { describe, expect, it } from "vitest";
import { partiesIn } from "./party";
import type { Thread } from "./thread";
import {
  appendOutbound,
  composedEntry,
  markAnswered,
  markClosed,
  newThread,
  nextThreadId,
  threadToContinue,
  type ComposedMessage,
} from "./threadUpdate";
import { DAY_MS } from "../time/dates";

const NOW = Date.parse("2026-07-24T11:02:00");

const composed = (overrides: Partial<ComposedMessage> = {}): ComposedMessage => ({
  now: NOW,
  actor: "yh",
  channel: "email",
  with: ["[[Dr A Tan]]"],
  requests: ["REQ-2026-014"],
  subject: "RE: 30-day readmission cohort",
  via: "mailto",
  summary: "Chased DUA countersignature",
  ...overrides,
});

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
    lastOutbound: NOW - 9 * DAY_MS,
    lastInbound: null,
    awaiting: "them",
    state: "open",
    messages: [],
    raw: {},
    ...overrides,
  };
}

describe("nextThreadId", () => {
  it("allocates the next four-digit label for the year", () => {
    expect(nextThreadId([], 2026)).toBe("THR-2026-0001");
    expect(nextThreadId(["THR-2026-0090", "THR-2026-0091"], 2026)).toBe("THR-2026-0092");
  });

  it("ignores other years and other prefixes", () => {
    expect(nextThreadId(["THR-2025-0500", "REQ-2026-014"], 2026)).toBe("THR-2026-0001");
  });
});

describe("newThread", () => {
  const created = newThread({ ...composed(), id: "THR-2026-0091", uid: "UID" });

  it("opens with the ball in their court", () => {
    // This is what makes the thread age into the holdup view with no mailbox
    // access at all (§5.10, Tier 0).
    expect(created.frontmatter["awaiting"]).toBe("them");
    expect(created.frontmatter["state"]).toBe("open");
    expect(created.frontmatter["last_outbound"]).toBe("2026-07-24");
    expect(created.frontmatter["last_inbound"]).toBeNull();
  });

  it("records that the message was composed, not that it was sent", () => {
    // §5.11 rule 6. We handed a draft to a handler; the user may have closed it.
    const messages = created.frontmatter["messages"] as Record<string, unknown>[];
    expect(messages[0]?.["composed_only"]).toBe(true);
    expect(created.audit[0]?.action).toBe("message-composed");
    expect(created.audit[0]?.detail).toContain("composed, not sent");
  });

  it("stores a summary and no message body", () => {
    const messages = created.frontmatter["messages"] as Record<string, unknown>[];
    expect(messages[0]?.["summary"]).toBe("Chased DUA countersignature");
    expect(Object.keys(messages[0]!)).not.toContain("body");
  });

  it("names the file after the human label and links the request", () => {
    expect(created.filename).toBe("THR-2026-0091.md");
    expect(created.frontmatter["requests"]).toEqual(["REQ-2026-014"]);
  });

  it("keeps people exactly as they were written", () => {
    const link = newThread({
      ...composed({ with: ["[[30 People/Dr A Tan|Tan]]"] }),
      id: "T",
      uid: "U",
    });
    expect(link.frontmatter["with"]).toEqual(["[[30 People/Dr A Tan|Tan]]"]);
  });
});

describe("composedEntry", () => {
  it("counts recipients rather than naming them", () => {
    // A clinician's name in a governance ledger is exactly the indirectly
    // identifying material §2 warns the vault may hold.
    const entry = composedEntry(composed({ with: ["[[Dr A Tan]]", "[[Dr B Lim]]"] }));
    expect(entry.detail).toContain("2 recipients");
    expect(entry.detail).not.toContain("Tan");
    expect(entry.subject).toBe("REQ-2026-014");
  });

  it("gets the singular right", () => {
    expect(composedEntry(composed()).detail).toContain("1 recipient;");
  });

  it("says so when the message is about no request at all", () => {
    expect(composedEntry(composed({ requests: [] })).subject).toBe("no request");
  });
});

describe("appendOutbound", () => {
  const patch = appendOutbound(composed());

  it("puts the ball back with them and reopens an answered thread", () => {
    // Leaving it "answered" would take it straight back out of the ageing list
    // it has just earned a place in.
    expect(patch.set["awaiting"]).toBe("them");
    expect(patch.set["state"]).toBe("open");
    expect(patch.set["last_outbound"]).toBe("2026-07-24");
  });

  it("appends rather than replacing the message history", () => {
    expect(patch.appendMessage).toBeDefined();
    expect(patch.set["messages"]).toBeUndefined();
  });

  it("logs the composition", () => {
    expect(patch.audit.map((entry) => entry.action)).toEqual(["message-composed"]);
  });
});

describe("markAnswered", () => {
  it("closes the loop and hands the ball back to us", () => {
    const patch = markAnswered({ now: NOW });
    expect(patch.set["awaiting"]).toBe("me");
    expect(patch.set["state"]).toBe("answered");
    expect(patch.set["last_inbound"]).toBe("2026-07-24");
  });

  it("stays one click: no summary required", () => {
    expect(markAnswered({ now: NOW }).appendMessage).toBeUndefined();
    expect(markAnswered({ now: NOW, summary: "  " }).appendMessage).toBeUndefined();
  });

  it("records an inbound message when a summary is given, without composed_only", () => {
    // We did not compose it, so the composed/sent distinction does not apply.
    const patch = markAnswered({ now: NOW, summary: "DUA countersigned", via: "email" });
    expect(patch.appendMessage?.["dir"]).toBe("inbound");
    expect(patch.appendMessage).not.toHaveProperty("composed_only");
  });

  it("is not logged", () => {
    // §5.6 lists what a consequential action is; a human replying to a human
    // is none of them, and logging it would bury the entries that matter.
    expect(markAnswered({ now: NOW }).audit).toEqual([]);
    expect(markClosed(NOW).audit).toEqual([]);
  });
});

describe("threadToContinue", () => {
  it("continues an open thread with the same person about the same request", () => {
    expect(threadToContinue([thread()], ["[[Dr A Tan]]"], ["REQ-2026-014"])?.id).toBe(
      "THR-2026-0091",
    );
  });

  it("matches across spellings of the same person and the same request", () => {
    expect(
      threadToContinue([thread()], ["[[30 People/Dr A Tan|Tan]]"], ["[[REQ-2026-014]]"])?.id,
    ).toBe("THR-2026-0091");
  });

  it("starts a new thread for a different request with the same person", () => {
    // Folding two asks into one thread would make "how long has this been
    // waiting" meaningless.
    expect(threadToContinue([thread()], ["[[Dr A Tan]]"], ["REQ-2026-099"])).toBeNull();
  });

  it("starts a new thread for a different person", () => {
    expect(threadToContinue([thread()], ["[[Dr B Lim]]"], ["REQ-2026-014"])).toBeNull();
  });

  it("never continues a closed thread", () => {
    expect(
      threadToContinue([thread({ state: "closed" })], ["[[Dr A Tan]]"], ["REQ-2026-014"]),
    ).toBeNull();
  });

  it("prefers an open thread over an answered one, then the most recent", () => {
    const answered = thread({ id: "answered", state: "answered", lastOutbound: NOW });
    const open = thread({ id: "open", state: "open", lastOutbound: NOW - 30 * DAY_MS });
    expect(threadToContinue([answered, open], ["[[Dr A Tan]]"], ["REQ-2026-014"])?.id).toBe("open");
  });

  it("matches a message about nothing only to a thread about nothing", () => {
    expect(threadToContinue([thread()], ["[[Dr A Tan]]"], [])).toBeNull();
    expect(
      threadToContinue([thread({ requests: [] })], ["[[Dr A Tan]]"], [])?.id,
    ).toBe("THR-2026-0091");
  });

  it("returns null when there is nobody to match on", () => {
    expect(threadToContinue([thread()], [], ["REQ-2026-014"])).toBeNull();
  });
});
