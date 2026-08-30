import { describe, expect, it } from "vitest";
import { threadKeyOf } from "./emlThread";
import { parseMsg } from "./msg";
import {
  attachmentNotes,
  isMailClass,
  outlookItemToMessage,
  parseBridgeReport,
  parseOutlookDate,
  readOutlookItem,
  unhex,
  type OutlookItem,
} from "./outlook";
import {
  prop,
  writeMsg,
  PT_LONG,
  PT_SYSTIME,
  PT_UNICODE,
  type MsgSpec,
  type Prop,
} from "../../../tests/helpers/msgFixture";

const MESSAGE_CLASS = 0x001a;
const SUBJECT = 0x0037;
const SUBMIT_TIME = 0x0039;
const BODY = 0x1000;
const RECIPIENT_TYPE = 0x0c15;
const SENDER_NAME = 0x0c1a;
const DISPLAY_NAME = 0x3001;
const SMTP_ADDRESS = 0x39fe;
const SENDER_SMTP_ADDRESS = 0x5d01;

/** A plausible COM record, with anything a test cares about overridden. */
function item(overrides: Partial<OutlookItem> = {}): OutlookItem {
  return {
    entryId: "0000FEEDFACE",
    folder: "Inbox",
    messageClass: "IPM.Note",
    headers: "",
    subject: "RE: 30-day readmission cohort",
    body: "Approved — please proceed with REQ-2026-014.",
    htmlBody: "",
    sentOn: "2026-08-14T17:12:33+08:00",
    receivedTime: "2026-08-14T17:12:40+08:00",
    senderName: "Dr A Tan",
    senderAddress: "a.tan@example.org",
    senderAddressType: "SMTP",
    senderSmtp: "a.tan@example.org",
    internetMessageId: "<reply2@mail>",
    inReplyTo: "",
    references: "",
    conversationIndex: "",
    recipients: [{ name: "YH", address: "yh@example.org", kind: 1 }],
    attachments: [],
    problems: [],
    ...overrides,
  };
}

const read = (overrides: Partial<OutlookItem> = {}) => outlookItemToMessage(item(overrides));

describe("one item, read as the message every other path produces", () => {
  it("reads subject, body, sender and recipient", () => {
    const message = read();
    expect(message.subject).toBe("RE: 30-day readmission cohort");
    expect(message.body).toBe("Approved — please proceed with REQ-2026-014.");
    expect(message.from).toEqual([
      { name: "Dr A Tan", address: "a.tan@example.org", key: "a.tan@example.org" },
    ]);
    expect(message.to.map((address) => address.address)).toEqual(["yh@example.org"]);
    expect(message.problems).toEqual([]);
  });

  it("records the format, so a reader can weigh how the identity was got", () => {
    expect(read().format).toBe("outlook");
  });

  it("carries no attachment bytes, ever", () => {
    // Not an omission: pulling the bytes would mean writing outside the vault
    // (rule 8) or shipping megabytes of regulated content through a pipe. The
    // files are named instead, and the note says where they still are.
    const message = read({ attachments: ["DUA-2026-018 countersigned.pdf"] });
    expect(message.attachments).toEqual([]);
    expect(attachmentNotes(item({ attachments: ["DUA.pdf"] }))[0]).toContain("still in Outlook");
  });
});

describe("the transport headers win wherever they exist", () => {
  const headers = [
    "Message-ID: <real-id@mail.example>",
    "References: <root@mail.example> <second@mail.example>",
    "From: A Tan <a.tan@example.org>",
    "Date: Fri, 14 Aug 2026 17:12:33 +0800",
    "Subject: RE: 30-day readmission cohort",
  ].join("\r\n");

  it("prefers the header id over MAPI's copy", () => {
    // The header block is what the message actually travelled with, so an
    // `.eml` of the same message agrees with it exactly rather than nearly.
    const message = read({ headers, internetMessageId: "<something-else@mail>" });
    expect(message.messageId).toBe("real-id@mail.example");
  });

  it("takes the whole References chain, so the thread root matches an .eml", () => {
    expect(threadKeyOf(read({ headers }))).toBe("root@mail.example");
  });

  it("prefers the header date, and does not shift it across a time zone", () => {
    const message = read({ headers });
    expect(message.date).toBe(Date.UTC(2026, 7, 14, 9, 12, 33));
  });
});

describe("an Exchange sender is not an address", () => {
  it("refuses a directory name and says why", () => {
    const message = read({
      senderSmtp: "",
      senderAddress: "/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=abc",
      senderAddressType: "EX",
    });
    // Direction is decided by matching the sender against the user's own
    // mailboxes; a fabricated address would quietly answer a question the item
    // cannot answer.
    expect(message.from).toEqual([]);
    expect(message.problems.join(" ")).toContain("directory entry");
  });

  it("uses the resolved SMTP address when Outlook could give one", () => {
    const message = read({
      senderSmtp: "a.tan@example.org",
      senderAddress: "/o=ExchangeLabs/cn=abc",
      senderAddressType: "EX",
    });
    expect(message.from[0]?.address).toBe("a.tan@example.org");
  });
});

describe("recipients", () => {
  it("splits To from Cc on the MAPI recipient type", () => {
    const message = read({
      recipients: [
        { name: "YH", address: "yh@example.org", kind: 1 },
        { name: "Coordinator B", address: "b@example.org", kind: 2 },
      ],
    });
    expect(message.to.map((a) => a.address)).toEqual(["yh@example.org"]);
    expect(message.cc.map((a) => a.address)).toEqual(["b@example.org"]);
  });

  it("drops a blind copy", () => {
    // A Bcc list exists only in the sender's own copy. Writing it into a
    // thread note would disclose what the other recipients were never shown.
    const message = read({
      recipients: [
        { name: "YH", address: "yh@example.org", kind: 1 },
        { name: "Hidden", address: "hidden@example.org", kind: 3 },
      ],
    });
    expect(JSON.stringify(message)).not.toContain("hidden@example.org");
  });

  it("skips an entry Outlook could not resolve to an address", () => {
    const message = read({
      recipients: [{ name: "Some Room", address: "/o=ExchangeLabs/cn=room", kind: 1 }],
    });
    expect(message.to).toEqual([]);
  });
});

describe("the body", () => {
  it("reduces HTML only when there is no plain text", () => {
    const message = read({ body: "", htmlBody: "<p>Hello</p><p>there</p>" });
    expect(message.bodyFromHtml).toBe(true);
    expect(message.body).toContain("Hello");
    expect(message.body).not.toContain("<p>");
  });

  it("keeps the plain body when both are present", () => {
    const message = read({ htmlBody: "<p>ignored</p>" });
    expect(message.bodyFromHtml).toBe(false);
    expect(message.body).not.toContain("ignored");
  });
});

describe("what counts as mail", () => {
  it("accepts notes and their subclasses", () => {
    expect(isMailClass("IPM.Note")).toBe(true);
    expect(isMailClass("IPM.Note.SMIME")).toBe(true);
  });

  it("refuses everything else", () => {
    // A meeting request read as correspondence files nonsense into a thread.
    expect(isMailClass("IPM.Schedule.Meeting.Request")).toBe(false);
    expect(isMailClass("REPORT.IPM.Note.NDR")).toBe(false);
    expect(isMailClass("IPM.Appointment")).toBe(false);
  });
});

describe("signed and encrypted mail is reported, never guessed at", () => {
  it("says a signature was not checked", () => {
    expect(read({ messageClass: "IPM.Note.SMIME.MultipartSigned" }).problems.join(" ")).toContain(
      "not checked",
    );
  });

  it("says an encrypted body was not read", () => {
    const message = read({ messageClass: "IPM.Note.SMIME" });
    expect(message.encrypted).toBe(true);
    expect(message.problems.join(" ")).toContain("stay in Outlook");
  });
});

describe("dates, computed rather than parsed", () => {
  it("reads an offset without letting the host's locale near it", () => {
    expect(parseOutlookDate("2026-08-14T17:12:33+08:00")).toBe(Date.UTC(2026, 7, 14, 9, 12, 33));
    expect(parseOutlookDate("2026-08-14T09:12:33Z")).toBe(Date.UTC(2026, 7, 14, 9, 12, 33));
    expect(parseOutlookDate("2026-08-14T17:12:33-0430")).toBe(Date.UTC(2026, 7, 14, 21, 42, 33));
  });

  it("does not shift a late-evening timestamp onto the wrong day", () => {
    // The bug the whole textual approach exists to avoid.
    expect(parseOutlookDate("2025-12-31T23:30:00+08:00")).toBe(Date.UTC(2025, 11, 31, 15, 30, 0));
  });

  it("returns nothing rather than guessing", () => {
    expect(parseOutlookDate("sometime last Tuesday")).toBeNull();
    expect(parseOutlookDate("")).toBeNull();
  });

  it("falls back from sent to received, and says when there is neither", () => {
    expect(read({ sentOn: "" }).date).toBe(Date.UTC(2026, 7, 14, 9, 12, 40));
    const undated = read({ sentOn: "", receivedTime: "" });
    expect(undated.date).toBeNull();
    expect(undated.problems.join(" ")).toContain("no readable date");
  });
});

describe("one conversation, whichever route it arrived by", () => {
  /** The same message, written as a `.msg` file. */
  function asMsgFile(overrides: Partial<MsgSpec> = {}): Uint8Array {
    const recipient: Prop[] = [
      prop(DISPLAY_NAME, PT_UNICODE, "YH"),
      prop(SMTP_ADDRESS, PT_UNICODE, "yh@example.org"),
      prop(RECIPIENT_TYPE, PT_LONG, 1),
    ];
    return writeMsg({
      props: [
        prop(MESSAGE_CLASS, PT_UNICODE, "IPM.Note"),
        prop(SUBJECT, PT_UNICODE, "RE: 30-day readmission cohort"),
        prop(BODY, PT_UNICODE, "Approved — please proceed with REQ-2026-014."),
        prop(SENDER_NAME, PT_UNICODE, "Dr A Tan"),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a.tan@example.org"),
        prop(SUBMIT_TIME, PT_SYSTIME, new Date("2026-08-14T09:12:33Z")),
      ],
      recipients: [recipient],
      ...overrides,
    });
  }

  it("gives a message with no id the identical synthesised one", () => {
    // The guarantee this whole module is shaped around. A message dragged out
    // of Outlook as a file and the same message read from the live session
    // must dedupe against each other — and they only do if both derive the
    // same identity. Two implementations of a thread key is two threads.
    const fromFile = parseMsg(asMsgFile());
    const fromCom = read({ internetMessageId: "", sentOn: "2026-08-14T17:12:33+08:00" });

    expect(fromFile.messageId).toMatch(/^msg-local:/);
    expect(fromCom.messageId).toBe(fromFile.messageId);
    expect(threadKeyOf(fromCom)).toBe(threadKeyOf(fromFile));
  });

  it("agrees on the thread root when both carry a real id", () => {
    const headers = "Message-ID: <r@mail>\r\nReferences: <root@mail>";
    expect(threadKeyOf(read({ headers }))).toBe("root@mail");
  });
});

describe("the Exchange conversation token, as a last resort only", () => {
  // 22 header bytes plus one response level: a reply inside a conversation
  // that never crossed the internet.
  const index = "01".repeat(22) + "aabbccdd";

  it("keys on the conversation when nothing internet-shaped is offered", () => {
    const message = read({ internetMessageId: "", conversationIndex: index });
    expect(threadKeyOf(message)).toMatch(/^msg-conv:/);
  });

  it("does not use it when the message has a real id and opened the thread", () => {
    // The defect a real Outlook file exposed on the `.msg` path: keying a
    // thread root on a GUID no `.eml` can carry splits one conversation in two
    // by which format it happened to be saved in.
    const header = "01".repeat(22);
    const message = read({ conversationIndex: header });
    expect(threadKeyOf(message)).toBe("reply2@mail");
  });

  it("prefers the parent's id, which an .eml can also agree with", () => {
    const message = read({ internetMessageId: "", inReplyTo: "<parent@mail>", conversationIndex: index });
    expect(threadKeyOf(message)).toBe("parent@mail");
  });
});

describe("hex", () => {
  it("reads whole bytes and nothing else", () => {
    expect(unhex("00ff")).toEqual(new Uint8Array([0, 255]));
    expect(unhex("0")).toBeNull();
    expect(unhex("zz")).toBeNull();
    expect(unhex("")).toBeNull();
  });
});

describe("the reader's reply, which crossed a process boundary", () => {
  it("reads a normal report", () => {
    const report = parseBridgeReport(
      JSON.stringify({ items: [item()], scanned: 40, skipped: 3, outlookVersion: "16.0.1" }),
    );
    if ("why" in report) throw new Error(report.why);
    expect(report.items).toHaveLength(1);
    expect(report.scanned).toBe(40);
    expect(report.outlookVersion).toBe("16.0.1");
  });

  it("passes an error through as a sentence", () => {
    const report = parseBridgeReport(JSON.stringify({ error: "Outlook is busy." }));
    expect("why" in report && report.why).toBe("Outlook is busy.");
  });

  it("refuses a reply that is not JSON, rather than throwing", () => {
    expect("why" in parseBridgeReport("At line:1 char:1")).toBe(true);
    expect("why" in parseBridgeReport("")).toBe(true);
    expect("why" in parseBridgeReport("[1,2,3]")).toBe(true);
  });

  it("keeps the readable items when one arrives malformed", () => {
    // The script is ours, but a process boundary is still a boundary: one bad
    // record must degrade to a counted problem, not to a TypeError inside a
    // review dialog.
    const report = parseBridgeReport(JSON.stringify({ items: [item(), 42, null] }));
    if ("why" in report) throw new Error(report.why);
    expect(report.items).toHaveLength(1);
    expect(report.problems.join(" ")).toContain("could not read");
  });

  it("narrows a record with missing fields instead of trusting it", () => {
    const narrowed = readOutlookItem({ subject: "x", recipients: [{ name: "a" }, 7] });
    expect(narrowed?.subject).toBe("x");
    expect(narrowed?.body).toBe("");
    expect(narrowed?.recipients).toEqual([{ name: "a", address: "", kind: 1 }]);
    expect(readOutlookItem("not a record")).toBeNull();
  });
});
