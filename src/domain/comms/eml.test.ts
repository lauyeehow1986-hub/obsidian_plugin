import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  decodeEncodedWords,
  decodeQuotedPrintable,
  latin1,
  parseAddressList,
  parseContentType,
  parseEml,
  parseHeaders,
  parseMailDate,
  parseReferences,
  splitHeaders,
  splitMultipart,
  stripAngles,
  unlatin1,
} from "./eml";

/** Build a message with CRLF line endings, which is what a real `.eml` has. */
function eml(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** Build one with raw bytes, for charsets UTF-8 cannot express. */
function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("byte helpers", () => {
  it("round-trips every byte value through latin1", () => {
    const all = Uint8Array.from({ length: 256 }, (_v, i) => i);
    expect([...unlatin1(latin1(all))]).toEqual([...all]);
  });

  it("survives a payload past the argument-list limit", () => {
    // `String.fromCharCode(...bytes)` throws somewhere around 100k arguments,
    // and a mail with a PDF attached is bigger than that. The chunking is not
    // an optimisation; without it the importer crashes on ordinary mail.
    const big = new Uint8Array(300_000).fill(0xab);
    expect(latin1(big)).toHaveLength(300_000);
    expect(unlatin1(latin1(big))[299_999]).toBe(0xab);
  });
});

describe("base64", () => {
  it("decodes with padding", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8="))).toBe("hello");
  });

  it("ignores the line breaks real mail wraps at 76 characters", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVs\r\nbG8=\r\n"))).toBe("hello");
  });

  it("decodes without padding rather than refusing", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8"))).toBe("hello");
  });

  it("returns bytes, not a string, so binary attachments survive", () => {
    // 0xC3 0x28 is invalid UTF-8. Going through a string would replace it.
    expect([...decodeBase64("wyg=")]).toEqual([0xc3, 0x28]);
  });
});

describe("quoted-printable", () => {
  it("decodes an escaped byte", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("30=3D30"))).toBe("30=30");
  });

  it("removes a soft line break and joins the line", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("read=\r\nmission"))).toBe("readmission");
    expect(new TextDecoder().decode(decodeQuotedPrintable("read=\nmission"))).toBe("readmission");
  });

  it("keeps an equals that is not a valid escape", () => {
    // `=42` really is an escape for "B", so a conformant encoder writes `=3D`
    // for a literal equals and the spec-correct reading is the one above.
    // What must not happen is the two characters after a *malformed* `=`
    // vanishing: that silently alters the text of a clinical email.
    expect(new TextDecoder().decode(decodeQuotedPrintable("n= 42 rows"))).toBe("n= 42 rows");
    expect(new TextDecoder().decode(decodeQuotedPrintable("100% =zz"))).toBe("100% =zz");
  });

  it("decodes a valid escape, which is what makes the case above malformed", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("n=42"))).toBe("nB");
  });

  it("decodes a multi-byte character split across escapes", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("=C2=A320"))).toBe("£20");
  });
});

describe("header splitting and unfolding", () => {
  it("splits on the first blank line", () => {
    const { head, body } = splitHeaders("Subject: hi\r\n\r\nbody here\r\n");
    expect(head).toBe("Subject: hi");
    expect(body).toBe("body here\r\n");
  });

  it("takes whichever blank line comes first when endings are mixed", () => {
    // A file copied through a text tool arrives with CRLF headers and an
    // LF-normalised body. Preferring CRLF unconditionally would swallow the
    // whole body into the header block.
    const { head, body } = splitHeaders("Subject: hi\n\nbody\r\n\r\nmore");
    expect(head).toBe("Subject: hi");
    expect(body).toBe("body\r\n\r\nmore");
  });

  it("unfolds a continued header into one field", () => {
    const headers = parseHeaders("Subject: a very long\r\n subject line\r\nTo: a@b.com");
    expect(headers[0]).toEqual({ name: "subject", value: "a very long subject line" });
    expect(headers[1]!.name).toBe("to");
  });

  it("lower-cases field names so lookup does not depend on the client", () => {
    expect(parseHeaders("MESSAGE-ID: <x@y>")[0]!.name).toBe("message-id");
  });
});

describe("RFC 2047 encoded words", () => {
  it("decodes a base64 word", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SGVsbG8=?=")).toBe("Hello");
  });

  it("decodes a Q word, where underscore is a space", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Dr_A_Tan?=")).toBe("Dr A Tan");
  });

  it("drops the whitespace between two adjacent encoded words", () => {
    // RFC 2047 §6.2. Keeping it inserts a space into the middle of the word a
    // long subject was split across.
    expect(decodeEncodedWords("=?UTF-8?Q?read?= =?UTF-8?Q?mission?=")).toBe("readmission");
  });

  it("keeps whitespace between an encoded word and ordinary text", () => {
    expect(decodeEncodedWords("RE: =?UTF-8?Q?cohort?= query")).toBe("RE: cohort query");
  });

  it("decodes a non-UTF-8 charset", () => {
    // =?ISO-8859-1?Q?=A320?= is "£20" in latin-1.
    expect(decodeEncodedWords("=?ISO-8859-1?Q?=A320?=")).toBe("£20");
  });

  it("reports an unknown charset instead of failing silently", () => {
    const problems: string[] = [];
    decodeEncodedWords("=?NOT-A-CHARSET?B?SGk=?=", problems);
    expect(problems[0]).toContain("NOT-A-CHARSET");
  });

  it("leaves text alone when there is nothing encoded", () => {
    expect(decodeEncodedWords("RE: 30-day readmission cohort")).toBe(
      "RE: 30-day readmission cohort",
    );
  });
});

describe("address lists", () => {
  it("reads a display name and an address", () => {
    expect(parseAddressList("Dr A Tan <a.tan@example.org>")).toEqual([
      { name: "Dr A Tan", address: "a.tan@example.org", key: "a.tan@example.org" },
    ]);
  });

  it("does not split on a comma inside a quoted display name", () => {
    // The failure this prevents: one clinician becoming two parties, one of
    // whom does not exist, on every thread they appear in.
    const parsed = parseAddressList('"Tan, A (Dr)" <a.tan@example.org>, b@example.org');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.name).toBe("Tan, A (Dr)");
    expect(parsed[1]!.address).toBe("b@example.org");
  });

  it("reads a bare address with no display name", () => {
    expect(parseAddressList("a.tan@example.org")[0]).toEqual({
      name: "",
      address: "a.tan@example.org",
      key: "a.tan@example.org",
    });
  });

  it("drops a group name that is not a mailbox", () => {
    expect(parseAddressList("Undisclosed recipients:;")).toEqual([]);
  });

  it("decodes an encoded display name", () => {
    expect(parseAddressList("=?UTF-8?Q?Dr_A_Tan?= <a@b.org>")[0]!.name).toBe("Dr A Tan");
  });

  it("drops a display name that merely repeats the address", () => {
    expect(parseAddressList("a@b.org <a@b.org>")[0]!.name).toBe("");
  });

  it("deduplicates one mailbox listed twice", () => {
    expect(parseAddressList("a@b.org, A@B.ORG")).toHaveLength(1);
  });

  it("ignores a comment in parentheses", () => {
    expect(parseAddressList("a@b.org (Dr Tan)")[0]!.address).toBe("a@b.org");
  });
});

describe("dates and ids", () => {
  it("reads an RFC 5322 date with an offset", () => {
    expect(parseMailDate("Tue, 14 Jul 2026 09:12:33 +0800")).toBe(
      Date.parse("2026-07-14T01:12:33Z"),
    );
  });

  it("strips the trailing comment Outlook appends", () => {
    expect(parseMailDate("Tue, 14 Jul 2026 09:12:33 +0800 (SGT)")).toBe(
      Date.parse("2026-07-14T01:12:33Z"),
    );
  });

  it("returns null for an unreadable date rather than guessing now", () => {
    expect(parseMailDate("some time last week")).toBeNull();
    expect(parseMailDate("")).toBeNull();
  });

  it("strips angle brackets from a message id", () => {
    expect(stripAngles("  <CAHk123@mail.example.org>  ")).toBe("CAHk123@mail.example.org");
  });

  it("reads references oldest first", () => {
    expect(parseReferences("<a@x> <b@x>\r\n <c@x>")).toEqual(["a@x", "b@x", "c@x"]);
  });

  it("gives no references for an empty header", () => {
    expect(parseReferences("")).toEqual([]);
  });
});

describe("content-type parameters", () => {
  it("reads the type and a quoted charset", () => {
    expect(parseContentType('text/plain; charset="utf-8"', "text/plain")).toEqual({
      mimeType: "text/plain",
      params: { charset: "utf-8" },
    });
  });

  it("defaults to the fallback when the header is absent", () => {
    expect(parseContentType("", "text/plain").mimeType).toBe("text/plain");
  });

  it("does not split on a semicolon inside a quoted filename", () => {
    const parsed = parseContentType('attachment; filename="a;b.pdf"', "");
    expect(parsed.params["filename"]).toBe("a;b.pdf");
  });

  it("joins an RFC 2231 continuation", () => {
    // Outlook splits any long filename this way.
    const parsed = parseContentType(
      "attachment; filename*0=\"DSRB-2026-0142 \"; filename*1=\"approval.pdf\"",
      "",
    );
    expect(parsed.params["filename"]).toBe("DSRB-2026-0142 approval.pdf");
  });

  it("decodes an RFC 2231 extended value with its charset", () => {
    const parsed = parseContentType("attachment; filename*=UTF-8''caf%C3%A9%20notes.pdf", "");
    expect(parsed.params["filename"]).toBe("café notes.pdf");
  });
});

describe("multipart splitting", () => {
  it("discards the preamble and the epilogue", () => {
    const chunks = splitMultipart(
      [
        "This is a multi-part message in MIME format.",
        "--BOUND",
        "one",
        "--BOUND",
        "two",
        "--BOUND--",
        "trailing junk",
      ].join("\r\n"),
      "BOUND",
    );
    expect(chunks).toEqual(["one", "two"]);
  });

  it("stops at the terminator", () => {
    const chunks = splitMultipart(["--B", "one", "--B--", "--B", "ghost"].join("\r\n"), "B");
    expect(chunks).toEqual(["one"]);
  });
});

describe("parseEml", () => {
  it("reads a plain-text message end to end", () => {
    const message = parseEml(
      eml(
        "Message-ID: <CAHk123@mail.example.org>",
        "Date: Tue, 14 Jul 2026 09:12:33 +0800",
        "From: Dr A Tan <a.tan@example.org>",
        "To: SCDB <scdb@example.org>",
        "Cc: Coordinator B <b@example.org>",
        "Subject: RE: 30-day readmission cohort",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Happy to approve. Please proceed.",
        "",
      ),
    );

    expect(message.messageId).toBe("CAHk123@mail.example.org");
    expect(message.from[0]!.address).toBe("a.tan@example.org");
    expect(message.to[0]!.address).toBe("scdb@example.org");
    expect(message.cc[0]!.address).toBe("b@example.org");
    expect(message.subject).toBe("RE: 30-day readmission cohort");
    expect(message.body).toBe("Happy to approve. Please proceed.");
    expect(message.bodyFromHtml).toBe(false);
    expect(message.problems).toEqual([]);
  });

  it("prefers the plain part of a multipart/alternative", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: multipart/alternative; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "the plain one",
        "--B",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>the html one</p>",
        "--B--",
        "",
      ),
    );

    expect(message.body).toBe("the plain one");
    expect(message.bodyFromHtml).toBe(false);
    // The HTML twin is not a file; saving it would put a .html next to every
    // imported message.
    expect(message.attachments).toEqual([]);
  });

  it("falls back to the HTML part and reduces it to text", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Approved.</p><p>Regards,<br>A</p></body></html>",
        "",
      ),
    );

    expect(message.bodyFromHtml).toBe(true);
    expect(message.body).toBe("Approved.\n\nRegards,\nA");
  });

  it("decodes a quoted-printable body in its declared charset", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Cost was =A3200 for the extract",
        "",
      ),
    );

    expect(message.body).toBe("Cost was £200 for the extract");
  });

  it("decodes a windows-1252 body that UTF-8 would have mangled", () => {
    // 0x92 is a right single quote in windows-1252 and invalid UTF-8. This is
    // the exact case that makes the parser take bytes rather than a string.
    const head = new TextEncoder().encode(
      [
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        "Content-Type: text/plain; charset=windows-1252",
        "",
        "don",
      ].join("\r\n"),
    );
    const message = parseEml(new Uint8Array([...head, ...bytes(0x92), ...new TextEncoder().encode("t")]));

    expect(message.body).toBe("don’t");
  });

  it("keeps a base64 attachment as bytes", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "See attached.",
        "--B",
        "Content-Type: application/pdf; name=\"approval.pdf\"",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="approval.pdf"',
        "",
        "JVBERi0xLjQK",
        "--B--",
        "",
      ),
    );

    expect(message.body).toBe("See attached.");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.filename).toBe("approval.pdf");
    expect(message.attachments[0]!.mimeType).toBe("application/pdf");
    expect(message.attachments[0]!.inline).toBe(false);
    // "%PDF-1.4\n" — the real magic bytes, not a re-encoded string.
    expect([...message.attachments[0]!.bytes.subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("marks a signature logo as inline so it can be left out", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: multipart/related; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "hello",
        "--B",
        "Content-Type: image/png",
        "Content-ID: <logo@example>",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: inline; filename="logo.png"',
        "",
        "iVBORw0KGgo=",
        "--B--",
        "",
      ),
    );

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.inline).toBe(true);
    expect(message.attachments[0]!.contentId).toBe("logo@example");
  });

  it("handles a multipart nested inside a multipart", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: multipart/mixed; boundary="OUT"',
        "",
        "--OUT",
        'Content-Type: multipart/alternative; boundary="IN"',
        "",
        "--IN",
        "Content-Type: text/plain",
        "",
        "nested plain",
        "--IN",
        "Content-Type: text/html",
        "",
        "<p>nested html</p>",
        "--IN--",
        "--OUT",
        "Content-Type: text/csv",
        'Content-Disposition: attachment; filename="rows.csv"',
        "",
        "a,b",
        "--OUT--",
        "",
      ),
    );

    expect(message.body).toBe("nested plain");
    expect(message.attachments.map((a) => a.filename)).toEqual(["rows.csv"]);
  });

  it("reports an encrypted message instead of importing gibberish", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        "",
        "MIAGCSqGSIb3DQEHA6CA",
        "",
      ),
    );

    expect(message.encrypted).toBe(true);
    expect(message.problems.join(" ")).toContain("encrypted");
  });

  it("says a signed message was not verified, and drops the signature blob", () => {
    const message = parseEml(
      eml(
        "From: a@b.org",
        "Date: Tue, 14 Jul 2026 09:12:33 +0000",
        'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "the real message",
        "--B",
        "Content-Type: application/pkcs7-signature; name=\"smime.p7s\"",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="smime.p7s"',
        "",
        "MIAGCSqGSIb3DQEH",
        "--B--",
        "",
      ),
    );

    expect(message.signed).toBe(true);
    expect(message.body).toBe("the real message");
    // Claiming a verified signature would be the lie; keeping the .p7s as an
    // "attachment" would just be noise.
    expect(message.attachments).toEqual([]);
    expect(message.problems.join(" ")).toContain("not checked");
  });

  it("reports a missing From rather than inventing a direction", () => {
    const message = parseEml(
      eml("Date: Tue, 14 Jul 2026 09:12:33 +0000", "Subject: no sender", "", "body", ""),
    );

    expect(message.from).toEqual([]);
    expect(message.problems.join(" ")).toContain("From");
  });

  it("does not throw on a file that is not a message at all", () => {
    const message = parseEml(new TextEncoder().encode("just some text, no headers"));
    expect(message.subject).toBe("");
    expect(message.problems.length).toBeGreaterThan(0);
  });

  it("stops descending a multipart nested past any real client", () => {
    // A hand-made message that nests without end must not take the stack with
    // it — an importer that crashes Obsidian on one bad file is worse than one
    // that reads it badly.
    const depth = 12;
    const lines: string[] = ["From: a@b.org", "Date: Tue, 14 Jul 2026 09:12:33 +0000"];
    for (let i = 0; i < depth; i++) {
      lines.push(`Content-Type: multipart/mixed; boundary="B${i}"`, "", `--B${i}`);
    }
    lines.push("Content-Type: text/plain", "", "deep");
    for (let i = depth - 1; i >= 0; i--) lines.push(`--B${i}--`);

    expect(() => parseEml(eml(...lines, ""))).not.toThrow();
  });
});
