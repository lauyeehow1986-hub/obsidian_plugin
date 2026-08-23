import { describe, expect, it } from "vitest";
import { isMsgFile, parseMsg } from "./msg";
import {
  prop,
  writeMsg,
  PT_BINARY,
  PT_BOOLEAN,
  PT_LONG,
  PT_STRING8,
  PT_SYSTIME,
  PT_UNICODE,
  type MsgSpec,
  type Prop,
} from "../../../tests/helpers/msgFixture";

/* Property ids, spelled out here so a test reads as what it is testing. */
const MESSAGE_CLASS = 0x001a;
const SUBJECT = 0x0037;
const SUBMIT_TIME = 0x0039;
const CONVERSATION_INDEX = 0x0071;
const TRANSPORT_HEADERS = 0x007d;
const BODY = 0x1000;
const RTF_COMPRESSED = 0x1009;
const HTML = 0x1013;
const INTERNET_MESSAGE_ID = 0x1035;
const RECIPIENT_TYPE = 0x0c15;
const SENDER_NAME = 0x0c1a;
const SENDER_ADDRESS_TYPE = 0x0c1e;
const SENDER_ADDRESS = 0x0c1f;
const DELIVERY_TIME = 0x0e06;
const DISPLAY_NAME = 0x3001;
const ATTACH_DATA = 0x3701;
const ATTACH_METHOD = 0x3705;
const ATTACH_LONG_FILENAME = 0x3707;
const ATTACH_MIME_TAG = 0x370e;
const ATTACH_CONTENT_ID = 0x3712;
const ATTACH_HIDDEN = 0x7ffe;
const SMTP_ADDRESS = 0x39fe;
const SENDER_SMTP_ADDRESS = 0x5d01;
const INTERNET_CODEPAGE = 0x3fde;

const utf8 = (text: string) => new TextEncoder().encode(text);

/** An uncompressed RTF stream. Compression itself is covered in `rtf.test.ts`. */
function rtfStream(source: string): Uint8Array {
  const body = utf8(source);
  const out = new Uint8Array(16 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length - 4, true);
  view.setUint32(4, body.length, true);
  view.setUint32(8, 0x414c454d, true); // "MELA" — stored, not compressed
  out.set(body, 16);
  return out;
}

function recipient(name: string, address: string, kind: number): Prop[] {
  return [
    prop(DISPLAY_NAME, PT_UNICODE, name),
    prop(SMTP_ADDRESS, PT_UNICODE, address),
    prop(RECIPIENT_TYPE, PT_LONG, kind),
  ];
}

/** A plausible message, with anything a test cares about overridden. */
function build(overrides: Partial<MsgSpec> = {}): Uint8Array {
  const spec: MsgSpec = {
    props: [
      prop(MESSAGE_CLASS, PT_UNICODE, "IPM.Note"),
      prop(SUBJECT, PT_UNICODE, "RE: 30-day readmission cohort"),
      prop(BODY, PT_UNICODE, "Approved — please proceed with REQ-2026-014."),
      prop(SENDER_NAME, PT_UNICODE, "Dr A Tan"),
      prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a.tan@example.org"),
      prop(SUBMIT_TIME, PT_SYSTIME, new Date("2026-08-14T09:12:33Z")),
      prop(INTERNET_MESSAGE_ID, PT_UNICODE, "<reply2@mail>"),
    ],
    recipients: [recipient("YH", "yh@example.org", 1)],
    ...overrides,
  };
  return writeMsg(spec);
}

const parse = (overrides: Partial<MsgSpec> = {}) => parseMsg(build(overrides));

describe("isMsgFile", () => {
  it("accepts a compound file", () => {
    expect(isMsgFile(build())).toBe(true);
  });

  it("rejects an .eml, so the importer can pick a parser by content", () => {
    expect(isMsgFile(utf8("From: a@b.example\r\n\r\nhello"))).toBe(false);
  });
});

describe("parseMsg — the ordinary case", () => {
  it("reads subject, body, sender and recipient", () => {
    const message = parse();

    expect(message.subject).toBe("RE: 30-day readmission cohort");
    expect(message.body).toBe("Approved — please proceed with REQ-2026-014.");
    expect(message.from).toEqual([
      { name: "Dr A Tan", address: "a.tan@example.org", key: "a.tan@example.org" },
    ]);
    expect(message.to.map((address) => address.address)).toEqual(["yh@example.org"]);
    expect(message.problems).toEqual([]);
  });

  it("records the format, because the two are not equally trustworthy", () => {
    expect(parse().format).toBe("msg");
  });

  it("converts a FILETIME to the right instant", () => {
    // Off-by-one in the 1601 epoch or the 100-nanosecond tick would move this
    // by years or by hours respectively, and neither is obvious by eye.
    expect(parse().date).toBe(Date.parse("2026-08-14T09:12:33Z"));
  });

  it("falls back to the delivery time when nothing was submitted", () => {
    const message = parse({
      props: [
        prop(SUBJECT, PT_UNICODE, "Delivered only"),
        prop(DELIVERY_TIME, PT_SYSTIME, new Date("2026-08-15T10:00:00Z")),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a.tan@example.org"),
      ],
    });
    expect(message.date).toBe(Date.parse("2026-08-15T10:00:00Z"));
  });

  it("says so when there is no readable date at all", () => {
    const message = parse({
      props: [prop(SUBJECT, PT_UNICODE, "No date"), prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example")],
    });
    expect(message.date).toBeNull();
    expect(message.problems.join(" ")).toContain("No readable date");
  });

  it("splits To and Cc, and drops Bcc", () => {
    const message = parse({
      recipients: [
        recipient("YH", "yh@example.org", 1),
        recipient("Coordinator B", "b@example.org", 2),
        // A blind copy is visible only in the sender's own file. Writing it
        // into a thread note would disclose what the recipients never saw.
        recipient("Quiet Watcher", "watcher@example.org", 3),
      ],
    });

    expect(message.to.map((a) => a.address)).toEqual(["yh@example.org"]);
    expect(message.cc.map((a) => a.address)).toEqual(["b@example.org"]);
    expect(JSON.stringify(message)).not.toContain("watcher@example.org");
  });

  it("keeps a display name only when it adds something", () => {
    const message = parse({
      recipients: [recipient("yh@example.org", "yh@example.org", 1)],
    });
    expect(message.to[0]!.name).toBe("");
  });
});

describe("parseMsg — the original headers", () => {
  const headers = [
    "Message-ID: <real-id@mail.example>",
    "Date: Fri, 14 Aug 2026 09:12:33 +0000",
    "From: Dr A Tan <a.tan@example.org>",
    "To: YH <yh@example.org>",
    "References: <root1@mail> <reply1@mail>",
    "In-Reply-To: <reply1@mail>",
    "Subject: RE: 30-day readmission cohort",
  ].join("\r\n");

  it("prefers the transported header block over the MAPI copies", () => {
    // This is what makes a `.msg` thread with an `.eml` of the same
    // conversation instead of beside it.
    const message = parse({
      props: [
        prop(TRANSPORT_HEADERS, PT_UNICODE, headers),
        prop(SUBJECT, PT_UNICODE, "RE: 30-day readmission cohort"),
        prop(BODY, PT_UNICODE, "text"),
        prop(INTERNET_MESSAGE_ID, PT_UNICODE, "<mapi-copy@mail>"),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "someone.else@example.org"),
      ],
    });

    expect(message.messageId).toBe("real-id@mail.example");
    expect(message.references).toEqual(["root1@mail", "reply1@mail"]);
    expect(message.inReplyTo).toBe("reply1@mail");
    expect(message.from[0]!.address).toBe("a.tan@example.org");
    expect(message.date).toBe(Date.parse("2026-08-14T09:12:33Z"));
  });

  it("uses the MAPI message id when there is no header block", () => {
    expect(parse().messageId).toBe("reply2@mail");
  });
});

describe("parseMsg — identity when the file carries none", () => {
  const bare: Partial<MsgSpec> = {
    props: [
      prop(SUBJECT, PT_UNICODE, "Internal note"),
      prop(BODY, PT_UNICODE, "No internet identity anywhere in this one."),
      prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a.tan@example.org"),
      prop(SUBMIT_TIME, PT_SYSTIME, new Date("2026-08-14T09:12:33Z")),
    ],
  };

  it("synthesises an id that is stable across imports", () => {
    // Without this, re-importing the same folder appends every message again.
    expect(parse(bare).messageId).toBe(parse(bare).messageId);
  });

  it("marks a synthesised id as one, rather than faking a Message-ID", () => {
    const id = parse(bare).messageId;
    expect(id.startsWith("msg-local:")).toBe(true);
    expect(id).not.toContain("@");
  });

  it("gives two different messages two different ids", () => {
    const other = parse({
      props: [...bare.props!.slice(1), prop(SUBJECT, PT_UNICODE, "A different note")],
    });
    expect(parse(bare).messageId).not.toBe(other.messageId);
  });

  it("threads on the conversation index when there is no References chain", () => {
    const index = new Uint8Array(22);
    index.set([0xab, 0xcd, 0xef, 0x01], 6);
    const message = parse({
      props: [...bare.props!, prop(CONVERSATION_INDEX, PT_BINARY, index)],
    });

    // Its own namespace: it groups `.msg` files with each other and cannot be
    // mistaken for — or matched against — an internet message id.
    expect(message.references).toEqual(["msg-conv:abcdef01000000000000000000000000"]);
  });

  it("gives two messages in one Exchange conversation the same thread root", () => {
    const index = new Uint8Array(30);
    index.set([0x11, 0x22, 0x33, 0x44], 6);
    const other = new Uint8Array(40);
    other.set([0x11, 0x22, 0x33, 0x44], 6);

    const first = parse({ props: [...bare.props!, prop(CONVERSATION_INDEX, PT_BINARY, index)] });
    const second = parse({
      props: [
        ...bare.props!.slice(1),
        prop(SUBJECT, PT_UNICODE, "RE: Internal note"),
        prop(CONVERSATION_INDEX, PT_BINARY, other),
      ],
    });

    expect(first.references[0]).toBe(second.references[0]);
    expect(first.messageId).not.toBe(second.messageId);
  });
});

describe("parseMsg — senders Exchange will not spell out", () => {
  it("refuses to invent an address from an Exchange directory entry", () => {
    // Internally, PidTagSenderEmailAddress is an X.500 name, not a mailbox.
    // Direction is decided by matching the sender against the user's own
    // addresses, so a fabricated one would answer a question the file cannot.
    const message = parse({
      props: [
        prop(SUBJECT, PT_UNICODE, "Internal"),
        prop(BODY, PT_UNICODE, "text"),
        prop(SENDER_NAME, PT_UNICODE, "Dr A Tan"),
        prop(SENDER_ADDRESS_TYPE, PT_UNICODE, "EX"),
        prop(SENDER_ADDRESS, PT_UNICODE, "/o=Exchange/ou=Group/cn=Recipients/cn=atan"),
      ],
    });

    expect(message.from).toEqual([]);
    expect(message.problems.join(" ")).toContain("Dr A Tan");
    expect(message.problems.join(" ")).toContain("which way the message went cannot be told");
  });

  it("uses a plain SMTP sender address when the type says it is one", () => {
    const message = parse({
      props: [
        prop(SUBJECT, PT_UNICODE, "External"),
        prop(BODY, PT_UNICODE, "text"),
        prop(SENDER_ADDRESS_TYPE, PT_UNICODE, "SMTP"),
        prop(SENDER_ADDRESS, PT_UNICODE, "outside@example.com"),
        prop(SUBMIT_TIME, PT_SYSTIME, new Date("2026-08-14T09:12:33Z")),
      ],
    });

    expect(message.from[0]!.address).toBe("outside@example.com");
    expect(message.problems).toEqual([]);
  });
});

describe("parseMsg — bodies", () => {
  it("prefers plain text", () => {
    const message = parse({
      props: [
        prop(BODY, PT_UNICODE, "the plain one"),
        prop(HTML, PT_BINARY, utf8("<p>the html one</p>")),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("the plain one");
    expect(message.bodyFromHtml).toBe(false);
  });

  it("reduces HTML when there is no plain part", () => {
    const message = parse({
      props: [
        prop(HTML, PT_BINARY, utf8("<p>First line.</p><p>Second line.</p>")),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("First line.\n\nSecond line.");
    expect(message.bodyFromHtml).toBe(true);
  });

  it("believes the charset the markup declares over the one MAPI declares", () => {
    // Outlook records the store code page while the markup carries its own.
    // The markup's author chose the encoding of the bytes that follow it.
    const message = parse({
      props: [
        prop(INTERNET_CODEPAGE, PT_LONG, 1252),
        prop(HTML, PT_BINARY, utf8('<meta charset="utf-8"><p>Cost: £200 — agreed</p>')),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("Cost: £200 — agreed");
  });

  it("reads a compressed-RTF body when it is the only one there", () => {
    // Plenty of internal Outlook mail has neither a plain nor an HTML property.
    const message = parse({
      props: [
        prop(RTF_COMPRESSED, PT_BINARY, rtfStream("{\\rtf1\\ansi Only in RTF\\par Second line}")),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("Only in RTF\nSecond line");
  });

  it("reports an unreadable RTF body rather than dropping it silently", () => {
    const message = parse({
      props: [
        prop(RTF_COMPRESSED, PT_BINARY, new Uint8Array([1, 2, 3])),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("");
    expect(message.problems.join(" ")).toContain("compressed RTF");
  });

  it("reads an eight-bit string in the declared code page", () => {
    const message = parse({
      props: [
        prop(INTERNET_CODEPAGE, PT_LONG, 1252),
        // 0x92 is a right single quote in the WHATWG mapping, and a C1 control
        // in Node's — the divergence eml.ts pins down.
        // The fixture writes each code unit as one byte, so this escape puts
        // the literal byte 0x92 into the stream. That is a right single quote
        // in the WHATWG mapping and a C1 control in Node's -- the divergence
        // eml.ts pins down, reached here through a different door.
        prop(BODY, PT_STRING8, "don\u0092t send it"),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.body).toBe("don’t send it");
  });
});

describe("parseMsg — attachments", () => {
  it("reads a file attachment with its name and type", () => {
    const message = parse({
      attachments: [
        [
          prop(ATTACH_LONG_FILENAME, PT_UNICODE, "cohort-spec.csv"),
          prop(ATTACH_MIME_TAG, PT_UNICODE, "text/csv"),
          prop(ATTACH_DATA, PT_BINARY, utf8("id,value\n1,2\n")),
        ],
      ],
    });

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.filename).toBe("cohort-spec.csv");
    expect(message.attachments[0]!.mimeType).toBe("text/csv");
    expect(new TextDecoder().decode(message.attachments[0]!.bytes)).toBe("id,value\n1,2\n");
    expect(message.attachments[0]!.inline).toBe(false);
  });

  it("marks a hidden attachment with a content id as inline", () => {
    const message = parse({
      attachments: [
        [
          prop(ATTACH_LONG_FILENAME, PT_UNICODE, "logo.png"),
          prop(ATTACH_CONTENT_ID, PT_UNICODE, "logo@crest"),
          prop(ATTACH_HIDDEN, PT_BOOLEAN, true),
          prop(ATTACH_DATA, PT_BINARY, new Uint8Array([137, 80, 78, 71])),
        ],
      ],
    });

    expect(message.attachments[0]!.inline).toBe(true);
    expect(message.attachments[0]!.contentId).toBe("logo@crest");
  });

  it("names an attached email instead of unpacking it", () => {
    const message = parse({
      attachments: [
        [
          prop(ATTACH_METHOD, PT_LONG, 5),
          prop(DISPLAY_NAME, PT_UNICODE, "FW: earlier thread"),
        ],
      ],
    });

    expect(message.attachments).toEqual([]);
    expect(message.problems.join(" ")).toContain("FW: earlier thread");
    expect(message.problems.join(" ")).toContain("left in Outlook");
  });

  it("says so when an attachment has no readable content", () => {
    const message = parse({
      attachments: [[prop(ATTACH_LONG_FILENAME, PT_UNICODE, "missing.pdf")]],
    });

    expect(message.attachments).toEqual([]);
    expect(message.problems.join(" ")).toContain("missing.pdf");
  });

  it("carries a large attachment through intact", () => {
    // Over the mini-stream cutoff, so it takes the full-sector path.
    const payload = Uint8Array.from({ length: 40_000 }, (_unused, i) => i & 0xff);
    const message = parse({
      attachments: [
        [prop(ATTACH_LONG_FILENAME, PT_UNICODE, "scan.pdf"), prop(ATTACH_DATA, PT_BINARY, payload)],
      ],
    });

    expect(message.attachments[0]!.bytes.length).toBe(40_000);
    expect(message.attachments[0]!.bytes[39_999]).toBe(payload[39_999]);
  });
});

describe("parseMsg — signed and encrypted mail", () => {
  it("reports a signed message without claiming to have checked it", () => {
    const message = parse({
      props: [
        prop(MESSAGE_CLASS, PT_UNICODE, "IPM.Note.SMIME.MultipartSigned"),
        prop(SUBJECT, PT_UNICODE, "Signed"),
        prop(BODY, PT_UNICODE, "text"),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.signed).toBe(true);
    expect(message.encrypted).toBe(false);
    expect(message.problems.join(" ")).toContain("signature was not checked");
  });

  it("reports an encrypted message", () => {
    const message = parse({
      props: [
        prop(MESSAGE_CLASS, PT_UNICODE, "IPM.Note.SMIME"),
        prop(SUBJECT, PT_UNICODE, "Encrypted"),
        prop(SENDER_SMTP_ADDRESS, PT_UNICODE, "a@b.example"),
      ],
    });

    expect(message.encrypted).toBe(true);
    expect(message.problems.join(" ")).toContain("stay in Outlook");
  });
});
