/**
 * The Outlook reader's boundaries, enforced rather than described.
 *
 * Two of the claims `services/outlookBridge` makes about itself are the kind
 * that decays quietly: *"it attaches, it never launches"* and *"nothing is ever
 * interpolated into PowerShell source"*. Both are one careless edit away from
 * being false, and neither would fail a unit test of the parser — the script is
 * a string that is handed to another process, so nothing type-checks it.
 *
 * So this reads the module's own source, the same blunt approach
 * `oneGateway.test.ts` takes to rule 3. The fix when it fails is always the
 * same: put the value in the environment, not in the script.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeCommand, MAX_BODY_CHARS, sinceArgument } from "../src/services/outlookBridge";
import { readSummary, windowStart } from "../src/services/outlookSync";

const SOURCE = "src/services/outlookBridge.ts";

/**
 * Every PowerShell body in the module, concatenated.
 *
 * All of them, not just the reader: the probe attaches to Outlook too, and a
 * guard that covered one script and not the other would be exactly the kind of
 * partial check that reads as protection without being any.
 */
function script(): string {
  const text = readFileSync(SOURCE, "utf8");
  const blocks: string[] = [];

  for (const marker of ["const SCRIPT = String.raw`", "const PROBE = String.raw`"]) {
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const from = start + marker.length;
    const to = text.indexOf("`;", from);
    expect(to).toBeGreaterThan(from);
    blocks.push(text.slice(from, to));
  }

  expect(blocks).toHaveLength(2);
  return blocks.join("\n");
}

describe("the reader attaches to Outlook and never starts it", () => {
  it("binds to a running instance", () => {
    // Once per script, so neither can quietly stop using it.
    expect(script().split("GetActiveObject").length - 1).toBe(2);
  });

  it("never constructs the Outlook application object", () => {
    // `New-Object -ComObject Outlook.Application` *launches* Outlook: mail
    // downloads, notifications fire, a password box may appear. A sync that
    // opens your mail client is exactly the surprise rule 12 forbids.
    expect(script()).not.toMatch(/New-Object\s+-ComObject/i);
    expect(script()).not.toMatch(/Start-Process/i);
  });

  it("never writes, sends, moves or deletes anything", () => {
    // The reader is read-only by construction, not by intention. Every one of
    // these is a MailItem method that changes a mailbox.
    for (const forbidden of [".Send(", ".Delete(", ".Save(", ".Move(", ".SaveAs", "MarkAsTask"]) {
      expect(script()).not.toContain(forbidden);
    }
  });

  it("never reaches a network", () => {
    // Rule 3: one gateway. A mailbox reader is local or it is nothing.
    for (const forbidden of ["Invoke-WebRequest", "Invoke-RestMethod", "System.Net", "curl"]) {
      expect(script()).not.toContain(forbidden);
    }
  });
});

describe("nothing from the vault reaches PowerShell source", () => {
  it("interpolates no JavaScript value into the script", () => {
    // `String.raw` with a `${` would splice a value into executable source.
    // Parameters go through the environment precisely so this can never be
    // the way a folder name or a date arrives.
    expect(script()).not.toContain("${");
  });

  it("takes its parameters from the environment", () => {
    for (const name of ["SCDB_FOLDERS", "SCDB_SINCE", "SCDB_MAX", "SCDB_MAXBODY"]) {
      expect(script()).toContain(`$env:${name}`);
    }
  });

  it("parses its date with the invariant culture, not the machine's", () => {
    // A locale-dependent date parse is how a reader silently reads the wrong
    // fortnight on a machine set to a different region.
    expect(script()).toContain("InvariantCulture");
  });

  it("is spawned without a shell and with array arguments", () => {
    const text = readFileSync(SOURCE, "utf8");
    expect(text).toContain("shell: false");
    // Windows PowerShell, not pwsh: `Marshal.GetActiveObject` is a .NET
    // Framework API and does not exist in .NET Core.
    expect(text).toContain('"powershell.exe"');
    expect(text).toContain("-NoProfile");
    expect(text).toContain("-NonInteractive");
  });
});

describe("encoding the command", () => {
  it("produces the UTF-16LE base64 PowerShell expects", () => {
    // "hi" as UTF-16LE is 68 00 69 00.
    expect(encodeCommand("hi")).toBe(Buffer.from([0x68, 0, 0x69, 0]).toString("base64"));
  });

  it("survives the characters a mail script actually contains", () => {
    const round = Buffer.from(encodeCommand("é—\n"), "base64").toString("utf16le");
    expect(round).toBe("é—\n");
  });
});

describe("the window a sync reads", () => {
  it("formats the boundary in the one shape the script parses", () => {
    expect(sinceArgument(new Date(2026, 7, 3, 9, 5))).toBe("2026-08-03 09:05");
  });

  it("starts at midnight, so 'the last 14 days' means whole days", () => {
    const start = windowStart(new Date(2026, 7, 30, 16, 40), 14);
    expect(sinceArgument(start)).toBe("2026-08-17 00:00");
  });

  it("reads today only when asked for one day", () => {
    const start = windowStart(new Date(2026, 7, 30, 16, 40), 1);
    expect(sinceArgument(start)).toBe("2026-08-30 00:00");
  });

  it("crosses a month boundary without arithmetic of its own", () => {
    const start = windowStart(new Date(2026, 2, 3, 12, 0), 7);
    expect(sinceArgument(start)).toBe("2026-02-25 00:00");
  });

  it("caps a body rather than shipping a mailbox through a pipe", () => {
    expect(MAX_BODY_CHARS).toBeGreaterThan(10_000);
    expect(MAX_BODY_CHARS).toBeLessThan(1_000_000);
  });
});

describe("what a read reports back", () => {
  const base = {
    preview: {
      actions: [],
      duplicates: 0,
      unreadable: [],
      messageCount: 0,
      attachmentCount: 0,
      problems: [],
    },
    offered: 31,
    notMail: 12,
    scanned: 240,
    elapsedMs: 1834,
    outlookVersion: "16.0.18827.20138",
    folders: ["Inbox", "Sent Items"],
    since: new Date(2026, 7, 17),
  };

  it("names counts, timing and the Outlook build", () => {
    // The sentence a person on a machine with no console can repeat back.
    // It is the difference between a bug that can be described and one that
    // cannot.
    const summary = readSummary(base);
    expect(summary).toContain("240 items looked at in Inbox and Sent Items");
    expect(summary).toContain("31 messages offered");
    expect(summary).toContain("12 not mail");
    expect(summary).toContain("1.8s");
    expect(summary).toContain("Outlook 16.0.18827.20138");
  });

  it("carries nothing that came out of a message", () => {
    // Rule 7. Every field in here is a count, a folder name or a build
    // number; none of it is content, and none of it can become content.
    const summary = readSummary({ ...base, folders: ["Inbox"] });
    expect(summary).toMatch(/^[0-9A-Za-z .·]+$/);
    expect(summary).not.toContain("@");
  });

  it("leaves out what does not apply", () => {
    const summary = readSummary({ ...base, notMail: 0, outlookVersion: "" });
    expect(summary).not.toContain("not mail");
    expect(summary).not.toContain("Outlook ");
  });
});
