import { describe, expect, it } from "vitest";
import { parseEml } from "./eml";
import {
  alreadyRecorded,
  appendEmlToThread,
  chainOf,
  correspondents,
  directionOf,
  importedMessageEntry,
  messageSection,
  newThreadFromEml,
  partyFor,
  planMessage,
  requestsMentioned,
  safeAttachmentName,
  threadForMessage,
  threadKeyOf,
  type PlanOptions,
} from "./emlThread";
import { parseThread, type Thread } from "./thread";

const ME = new Set(["yh@example.org"]);
const FALLBACK = Date.parse("2026-08-20T12:00:00Z");

function options(overrides: Partial<PlanOptions> = {}): PlanOptions {
  return {
    ownAddresses: ME,
    knownRequestIds: ["REQ-2026-014", "REQ-2026-004"],
    knownPeople: ["Dr A Tan"],
    attachments: "attachments",
    maxAttachmentKb: 10240,
    fallbackAt: FALLBACK,
    ...overrides,
  };
}

function message(...lines: string[]) {
  return parseEml(new TextEncoder().encode(lines.join("\r\n")));
}

/** A reply from Dr Tan, with a References chain. */
function inboundReply(overrides: { references?: string; messageId?: string } = {}) {
  return message(
    `Message-ID: <${overrides.messageId ?? "reply2@mail"}>`,
    "Date: Fri, 14 Aug 2026 09:12:33 +0000",
    "From: Dr A Tan <a.tan@example.org>",
    "To: YH <yh@example.org>",
    `References: <${overrides.references ?? "root1@mail"}>`,
    "In-Reply-To: <root1@mail>",
    "Subject: RE: 30-day readmission cohort",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Approved — please proceed with REQ-2026-014.",
    "",
  );
}

function plan(msg = inboundReply(), opts = options()) {
  return planMessage(msg, "75 Correspondence/reply.eml", opts);
}

function threadFrom(frontmatter: Record<string, unknown>): Thread {
  return parseThread(frontmatter, "THR-2026-0001").thread;
}

describe("direction", () => {
  it("is outbound when the sender is one of my addresses", () => {
    const sent = message("From: YH <yh@example.org>", "Date: Fri, 14 Aug 2026 09:00:00 +0000", "", "hi");
    expect(directionOf(sent.from, ME)).toBe("outbound");
  });

  it("is inbound when it is not", () => {
    expect(directionOf(inboundReply().from, ME)).toBe("inbound");
  });

  it("matches an address regardless of case", () => {
    const sent = message("From: YH <YH@Example.ORG>", "Date: Fri, 14 Aug 2026 09:00:00 +0000", "", "hi");
    expect(directionOf(sent.from, ME)).toBe("outbound");
  });
});

describe("thread key", () => {
  it("is the root of the References chain", () => {
    expect(threadKeyOf(inboundReply())).toBe("root1@mail");
  });

  it("falls back to In-Reply-To when References is absent", () => {
    const msg = message(
      "Message-ID: <b@mail>",
      "In-Reply-To: <a@mail>",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: a@b.org",
      "",
      "hi",
    );
    expect(threadKeyOf(msg)).toBe("a@mail");
  });

  it("is the message's own id when it starts a conversation", () => {
    const msg = message(
      "Message-ID: <first@mail>",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: a@b.org",
      "",
      "hi",
    );
    expect(threadKeyOf(msg)).toBe("first@mail");
  });

  it("gives every message in one chain the same key", () => {
    // The whole reason a fortnight of replies is one note and not nine.
    const first = threadKeyOf(inboundReply({ messageId: "r2@mail" }));
    const second = threadKeyOf(inboundReply({ messageId: "r3@mail" }));
    expect(first).toBe(second);
  });

  it("lists the whole chain, own id included", () => {
    expect(chainOf(inboundReply())).toEqual(["root1@mail", "reply2@mail"]);
  });
});

describe("correspondents", () => {
  it("leaves me out and keeps everyone else", () => {
    const msg = message(
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: Dr A Tan <a.tan@example.org>",
      "To: YH <yh@example.org>, Coordinator B <b@example.org>",
      "",
      "hi",
    );
    expect(correspondents(msg, ME, [])).toEqual(["[[Dr A Tan]]", "[[Coordinator B]]"]);
  });

  it("links to the person note when the display name matches exactly", () => {
    expect(partyFor({ name: "dr a tan", address: "a@b.org", key: "a@b.org" }, ["Dr A Tan"])).toBe(
      "[[Dr A Tan]]",
    );
  });

  it("does not guess at a person note it only half matches", () => {
    // Attributing a governance holdup to somebody on a substring is exactly
    // the guess this must not make.
    expect(partyFor({ name: "A Tan", address: "a@b.org", key: "a@b.org" }, ["Dr A Tan"])).toBe(
      "[[A Tan]]",
    );
  });

  it("writes a bare address rather than a wikilink when nobody is named", () => {
    expect(partyFor({ name: "", address: "helpdesk@example.org", key: "helpdesk@example.org" }, [])).toBe(
      "helpdesk@example.org",
    );
  });
});

describe("requests mentioned", () => {
  it("finds an id in the body", () => {
    expect(requestsMentioned(inboundReply(), ["REQ-2026-014"])).toEqual(["REQ-2026-014"]);
  });

  it("finds an id in the subject", () => {
    const msg = message(
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: a@b.org",
      "Subject: REQ-2026-004 update",
      "",
      "no id here",
    );
    expect(requestsMentioned(msg, ["REQ-2026-004"])).toEqual(["REQ-2026-004"]);
  });

  it("ignores an id the vault does not have", () => {
    // A sender can write any id they like. Only ones that exist are linked.
    expect(requestsMentioned(inboundReply(), ["REQ-2026-999"])).toEqual([]);
  });

  it("does not match a shorter id inside a longer one", () => {
    const msg = message(
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: a@b.org",
      "",
      "about REQ-2026-0141",
    );
    expect(requestsMentioned(msg, ["REQ-2026-014"])).toEqual([]);
  });

  it("matches an id written in a different case", () => {
    const msg = message("Date: Fri, 14 Aug 2026 09:00:00 +0000", "From: a@b.org", "", "req-2026-014");
    expect(requestsMentioned(msg, ["REQ-2026-014"])).toEqual(["REQ-2026-014"]);
  });
});

describe("planning", () => {
  it("dates the message from its header", () => {
    expect(plan().at).toBe(Date.parse("2026-08-14T09:12:33Z"));
  });

  it("falls back to the supplied time when the date is unreadable", () => {
    const msg = message("From: a@b.org", "Subject: no date", "", "hi");
    expect(plan(msg).at).toBe(FALLBACK);
  });

  it("skips an oversized attachment by name instead of writing it", () => {
    const big = message(
      "From: a@b.org",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--B",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="huge.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "A".repeat(4000),
      "--B--",
      "",
    );
    const result = plan(big, options({ maxAttachmentKb: 1 }));
    expect(result.attachments).toEqual([]);
    expect(result.skipped[0]).toContain("huge.pdf");
    expect(result.skipped[0]).toContain("over the 1 KB limit");
  });

  it("leaves a signature logo behind but says so", () => {
    const withLogo = message(
      "From: a@b.org",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      'Content-Type: multipart/related; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "hello",
      "--B",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      'Content-Disposition: inline; filename="logo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--B--",
      "",
    );
    expect(plan(withLogo).attachments).toEqual([]);
    expect(plan(withLogo).skipped[0]).toContain("logo.png");
    // ...unless asked for it explicitly.
    expect(plan(withLogo, options({ attachments: "all" })).attachments).toHaveLength(1);
  });

  it("strips path separators out of an attachment name", () => {
    // A filename is attacker-controlled. "../../evil.md" must not escape.
    expect(safeAttachmentName("../../evil.md", "attachment")).toBe(".. .. evil.md");
    expect(safeAttachmentName("", "attachment")).toBe("attachment");
    expect(safeAttachmentName("..", "attachment")).toBe("attachment");
  });
});

describe("new thread", () => {
  it("writes the §5.10 shape", () => {
    const note = newThreadFromEml(plan(), "THR-2026-0004", "01ULID");

    expect(note.filename).toBe("THR-2026-0004.md");
    expect(note.frontmatter["type"]).toBe("correspondence");
    expect(note.frontmatter["thread_key"]).toBe("root1@mail");
    expect(note.frontmatter["channel"]).toBe("email");
    expect(note.frontmatter["with"]).toEqual(["[[Dr A Tan]]"]);
    expect(note.frontmatter["requests"]).toEqual(["REQ-2026-014"]);
  });

  it("puts the ball with me for an inbound message", () => {
    const note = newThreadFromEml(plan(), "THR-2026-0004", "01ULID");
    expect(note.frontmatter["awaiting"]).toBe("me");
    expect(note.frontmatter["direction_last"]).toBe("inbound");
    expect(note.frontmatter["last_inbound"]).toBe("2026-08-14");
    expect(note.frontmatter["last_outbound"]).toBeNull();
  });

  it("puts the ball with them for one I sent", () => {
    const sent = message(
      "Message-ID: <mine@mail>",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "From: YH <yh@example.org>",
      "To: Dr A Tan <a.tan@example.org>",
      "Subject: DUA countersignature",
      "",
      "Chasing this.",
    );
    const note = newThreadFromEml(plan(sent), "THR-2026-0004", "01ULID");
    expect(note.frontmatter["awaiting"]).toBe("them");
    expect(note.frontmatter["state"]).toBe("open");
    expect(note.frontmatter["last_outbound"]).toBe("2026-08-14");
  });

  it("parses back through the thread reader it has to satisfy", () => {
    // The contract is not "what I wrote" but "what parseThread reads": a note
    // this module writes and B1's ageing cannot read is a broken thread.
    const note = newThreadFromEml(plan(), "THR-2026-0004", "01ULID");
    const parsed = parseThread(note.frontmatter, "THR-2026-0004");

    expect(parsed.problems).toEqual([]);
    expect(parsed.thread.awaiting).toBe("me");
    expect(parsed.thread.with[0]!.name).toBe("Dr A Tan");
    expect(parsed.thread.messages[0]!.messageId).toBe("reply2@mail");
  });
});

describe("message entries", () => {
  it("records the message id, so a second import is a no-op", () => {
    expect(importedMessageEntry(plan())["message_id"]).toBe("reply2@mail");
  });

  it("does not claim composed_only either way", () => {
    // §5.11 rule 6 invented that flag for messages we composed and cannot know
    // were sent. An imported message demonstrably existed; asserting `false`
    // would be a claim, and asserting `true` would be a lie.
    expect(importedMessageEntry(plan())).not.toHaveProperty("composed_only");
  });

  it("summarises with the subject and never the body", () => {
    const entry = importedMessageEntry(plan());
    expect(entry["summary"]).toBe("RE: 30-day readmission cohort");
    expect(JSON.stringify(entry)).not.toContain("Approved");
  });
});

describe("matching an existing thread", () => {
  const existing = threadFrom({
    type: "correspondence",
    id: "THR-2026-0004",
    thread_key: "root1@mail",
    with: ["[[Dr A Tan]]"],
    requests: ["REQ-2026-014"],
    awaiting: "them",
    state: "open",
    last_outbound: "2026-08-10",
    messages: [{ at: "2026-08-10T09:00", dir: "outbound", via: "mailto", message_id: "root1@mail" }],
  });

  it("finds the thread by its key", () => {
    expect(threadForMessage([existing], plan())?.id).toBe("THR-2026-0004");
  });

  it("finds it through a recorded message id when the key does not match", () => {
    const orphan = threadFrom({ ...existing.raw, thread_key: "" });
    expect(threadForMessage([orphan], plan())?.id).toBe("THR-2026-0004");
  });

  it("does not match on subject alone", () => {
    const unrelated = threadFrom({
      type: "correspondence",
      id: "THR-2026-0009",
      subject: "RE: 30-day readmission cohort",
      with: ["[[Dr A Tan]]"],
      thread_key: "",
      messages: [],
    });
    expect(threadForMessage([unrelated], plan())).toBeNull();
  });

  it("knows when a message is already recorded", () => {
    const withReply = threadFrom({
      ...existing.raw,
      messages: [
        ...(existing.raw["messages"] as unknown[]),
        { at: "2026-08-14T09:12", dir: "inbound", via: "eml-import", message_id: "reply2@mail" },
      ],
    });
    expect(alreadyRecorded(withReply, plan())).toBe(true);
    expect(alreadyRecorded(existing, plan())).toBe(false);
  });

  it("treats a message with no id as never already recorded", () => {
    const noId = message("From: a@b.org", "Date: Fri, 14 Aug 2026 09:00:00 +0000", "", "hi");
    expect(alreadyRecorded(existing, plan(noId))).toBe(false);
  });

  it("flips awaiting when the reply lands", () => {
    const patch = appendEmlToThread(plan(), existing);
    expect(patch.set["awaiting"]).toBe("me");
    expect(patch.set["state"]).toBe("answered");
    expect(patch.set["last_inbound"]).toBe("2026-08-14");
  });

  it("widens the request list rather than replacing it", () => {
    const other = threadFrom({ ...existing.raw, requests: ["REQ-2026-004"] });
    expect(appendEmlToThread(plan(), other).set["requests"]).toEqual([
      "REQ-2026-004",
      "REQ-2026-014",
    ]);
  });

  it("leaves the request list untouched when nothing new arrived", () => {
    expect(appendEmlToThread(plan(), existing).set).not.toHaveProperty("requests");
  });

  it("does not duplicate a party already on the thread", () => {
    expect(appendEmlToThread(plan(), existing).set).not.toHaveProperty("with");
  });
});

describe("the body section", () => {
  it("fences the message text", () => {
    const section = messageSection(plan());
    expect(section).toContain("```\nApproved — please proceed with REQ-2026-014.\n```");
  });

  it("lengthens the fence when the message contains one", () => {
    // Otherwise the fence closes early and the rest of the email escapes into
    // the note as markdown — including any [[wikilink]] the sender wrote.
    const fenced = message(
      "From: a@b.org",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "",
      "here is code:",
      "```",
      "rm -rf /",
      "```",
      "and [[Some Note]]",
    );
    const section = messageSection(plan(fenced));
    expect(section).toContain("````");
    // The wikilink is inside the fence, so it never joins the link graph.
    expect(section.split("````")[1]).toContain("[[Some Note]]");
  });

  it("names the sender, recipients and subject above the text", () => {
    const section = messageSection(plan());
    expect(section).toContain("Dr A Tan <a.tan@example.org>");
    expect(section).toContain("**To:** YH <yh@example.org>");
    expect(section).toContain("**Subject:** RE: 30-day readmission cohort");
  });

  it("says a body came from HTML rather than passing it off as sent text", () => {
    const html = message(
      "From: a@b.org",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      "Content-Type: text/html",
      "",
      "<p>Approved.</p>",
    );
    expect(messageSection(plan(html))).toContain("Reduced from an HTML message");
  });

  it("says the signature was not checked", () => {
    const signed = message(
      "From: a@b.org",
      "Date: Fri, 14 Aug 2026 09:00:00 +0000",
      'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "trust me",
      "--B--",
      "",
    );
    expect(messageSection(plan(signed))).toContain("signature was not checked");
  });

  it("handles a message with no readable body", () => {
    const empty = message("From: a@b.org", "Date: Fri, 14 Aug 2026 09:00:00 +0000", "", "");
    expect(messageSection(plan(empty))).toContain("(no readable body)");
  });
});
