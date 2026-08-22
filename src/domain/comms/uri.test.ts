import { describe, expect, it } from "vitest";
import {
  addressProblem,
  buildMailto,
  buildTeamsChat,
  checkAddresses,
  DEFAULT_URI_CEILING,
  deliveryFor,
  MIN_URI_CEILING,
  schemeAllowed,
  tooLongMessage,
} from "./uri";

const CRLF = "\r\n";

describe("addressProblem", () => {
  it("accepts ordinary institutional addresses", () => {
    for (const address of [
      "a.tan@hospital.edu.sg",
      "A.Tan@Hospital.Edu.SG",
      "first-last@sub.domain.org",
      "user+tag@example.com",
      "  spaced@example.com  ",
    ]) {
      expect(addressProblem(address), address).toBeNull();
    }
  });

  it("refuses a line break, naming what it would have done", () => {
    // §5.11 rule 3: the exact attack. `bcc:` would be a silent blind copy of a
    // message about a clinical data request.
    const problem = addressProblem(`a@b.com${CRLF}bcc:attacker@example.com`);
    expect(problem).toContain("line break");
    expect(problem).toContain("extra recipients");
  });

  it("refuses a bare CR and a bare LF, not only the pair", () => {
    expect(addressProblem("a@b.com\rbcc:x@y.com")).toContain("line break");
    expect(addressProblem("a@b.com\nbcc:x@y.com")).toContain("line break");
  });

  it("refuses a comma, because one address would silently become two", () => {
    expect(addressProblem("a@b.com,c@d.com")).toContain("not allowed");
  });

  it("refuses separators, quoting and bracketing characters", () => {
    for (const address of [
      "a@b.com;c@d.com",
      "Tan <a@b.com>",
      'a"b@c.com',
      "a b@c.com",
      "a\\b@c.com",
      "a@b.com\tx",
    ]) {
      expect(addressProblem(address), address).not.toBeNull();
    }
  });

  it("refuses control characters and non-ASCII", () => {
    expect(addressProblem("a\u0000b@c.com")).toContain("control");
    expect(addressProblem("\u00e5@example.com")).toContain("non-ASCII");
  });

  it("refuses things that are not addresses at all", () => {
    expect(addressProblem("")).toBe("is empty");
    expect(addressProblem("   ")).toBe("is empty");
    expect(addressProblem("nobody")).toContain("name@domain");
    expect(addressProblem("@example.com")).toContain("name@domain");
    expect(addressProblem("nobody@")).toContain("name@domain");
    expect(addressProblem("a@localhost")).toContain("no dot");
    expect(addressProblem("a@-b.com")).toContain("domain that is not valid");
    expect(addressProblem("a@b-.com")).toContain("domain that is not valid");
    expect(addressProblem(".a@b.com")).toContain("before the @");
    expect(addressProblem("a..b@c.com")).toContain("before the @");
  });

  it("refuses a percent-encoded injection written out literally", () => {
    // A note pasted from an email may carry the encoded form. It must not
    // survive to be decoded by a handler later.
    expect(addressProblem("a@b.com%0D%0Abcc:attacker@example.com")).not.toBeNull();
  });
});

describe("checkAddresses", () => {
  it("keeps the good, reports the bad, and does not stop at the first fault", () => {
    const result = checkAddresses(["ok@a.com", "bad,two@b.com", "also@c.com"], "Recipient");
    expect(result.usable).toEqual(["ok@a.com", "also@c.com"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain('Recipient "bad,two@b.com"');
  });

  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    const result = checkAddresses(["A.Tan@x.com", "a.tan@x.com"], "Recipient");
    expect(result.usable).toEqual(["A.Tan@x.com"]);
  });
});

describe("buildMailto", () => {
  it("builds to, cc, subject and body", () => {
    const result = buildMailto({
      to: ["a.tan@x.com"],
      cc: ["b@x.com"],
      subject: "REQ-2026-014",
      body: "Line one\nLine two",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.uri.uri).toBe(
      "mailto:a.tan@x.com?cc=b@x.com&subject=REQ-2026-014&body=Line%20one%0D%0ALine%20two",
    );
    expect(result.uri.length).toBe(result.uri.uri.length);
  });

  it("writes line breaks as %0D%0A whatever the input used", () => {
    // §5.11 names CRLF specifically; a lone %0A lands as a literal in some
    // Outlook builds instead of starting a new line.
    for (const body of ["a\nb", "a\r\nb", "a\rb"]) {
      const result = buildMailto({ to: ["a@b.com"], subject: "", body });
      expect(result.ok && result.uri.uri).toContain("body=a%0D%0Ab");
    }
  });

  it("omits parts that are empty rather than emitting bare keys", () => {
    const result = buildMailto({ to: ["a@b.com"], subject: "   ", body: "" });
    expect(result.ok && result.uri.uri).toBe("mailto:a@b.com");
  });

  it("refuses the whole draft when any address is bad", () => {
    // Partial send is the wrong answer: the user asked to write to these
    // people, and quietly dropping one is worse than refusing.
    const result = buildMailto({
      to: ["good@x.com", `evil@x.com${CRLF}bcc:attacker@example.com`],
      subject: "s",
      body: "b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toContain("line break");
  });

  it("refuses when there is nobody to write to", () => {
    const result = buildMailto({ to: [], subject: "s", body: "b" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContain("There is nobody to send this to.");
  });

  it("percent-encodes everything a body could carry", () => {
    const result = buildMailto({
      to: ["a@b.com"],
      subject: "50% & rising?",
      body: "see #3 / [[REQ-2026-014]]",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No unencoded & or ? survives inside a value; the only ones left are the
    // separators we placed.
    const query = result.uri.uri.slice(result.uri.uri.indexOf("?") + 1);
    expect(query.split("&")).toHaveLength(2);
    expect(result.uri.uri).toContain("subject=50%25%20%26%20rising%3F");
    expect(result.uri.uri).not.toContain("[[");
  });
});

describe("buildTeamsChat", () => {
  it("builds a deep link to the hardcoded host", () => {
    const result = buildTeamsChat({ users: ["a.tan@x.com"], message: "Hello there" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.uri.uri).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=a.tan@x.com&message=Hello%20there",
    );
  });

  it("validates UPNs exactly as it validates addresses", () => {
    const result = buildTeamsChat({ users: [`a@x.com${CRLF}x`], message: "m" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toContain("Teams user");
  });
});

describe("schemeAllowed", () => {
  it("allows the three schemes §5.11 names", () => {
    expect(schemeAllowed("mailto:a@b.com?subject=x")).toBe(true);
    expect(schemeAllowed("msteams:/l/chat/0/0")).toBe(true);
    expect(schemeAllowed("https://teams.microsoft.com/l/chat/0/0?users=a@b.com")).toBe(true);
  });

  it("refuses every other registered handler", () => {
    // shell.openExternal will happily start any of these.
    for (const uri of [
      "file:///C:/Windows/System32/calc.exe",
      "ms-msdt:/id",
      "vscode://file/c:/x",
      "javascript:alert(1)",
      "obsidian://open?vault=x",
      "http://teams.microsoft.com/l/chat/0/0",
      "",
      "a@b.com",
    ]) {
      expect(schemeAllowed(uri), uri).toBe(false);
    }
  });

  it("refuses an https URL that is not the Teams host", () => {
    // The only https we ever build is the Teams deep link, so anything else
    // arriving here did not come from us.
    expect(schemeAllowed("https://example.com/")).toBe(false);
    expect(schemeAllowed("https://teams.microsoft.com.example.com/l/chat")).toBe(false);
    expect(schemeAllowed("https://evil.com/?x=teams.microsoft.com/")).toBe(false);
  });

  it("is not fooled by capitalisation", () => {
    expect(schemeAllowed("MAILTO:a@b.com")).toBe(true);
    expect(schemeAllowed("JavaScript:alert(1)")).toBe(false);
    expect(schemeAllowed("HTTPS://TEAMS.MICROSOFT.COM/l/chat")).toBe(true);
  });
});

describe("the length guard", () => {
  const uri = (length: number) => ({ uri: "x".repeat(length), length });

  it("launches what fits and diverts what does not", () => {
    expect(deliveryFor(uri(DEFAULT_URI_CEILING), DEFAULT_URI_CEILING)).toBe("launch");
    expect(deliveryFor(uri(DEFAULT_URI_CEILING + 1), DEFAULT_URI_CEILING)).toBe("clipboard");
  });

  it("never truncates — the long draft is diverted whole", () => {
    // §5.11 rule 1. There is deliberately no code path that shortens a URI.
    const long = uri(9000);
    expect(deliveryFor(long, DEFAULT_URI_CEILING)).toBe("clipboard");
    expect(long.uri).toHaveLength(9000);
  });

  it("refuses to honour a ceiling so low nothing could be composed", () => {
    expect(deliveryFor(uri(MIN_URI_CEILING), 0)).toBe("launch");
    expect(deliveryFor(uri(MIN_URI_CEILING), -100)).toBe("launch");
  });

  it("says why, with both numbers", () => {
    const message = tooLongMessage(uri(2500), 1800);
    expect(message).toContain("2500");
    expect(message).toContain("1800");
    expect(message).toContain("clipboard");
  });
});
