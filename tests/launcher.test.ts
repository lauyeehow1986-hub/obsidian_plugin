/**
 * The launcher's guarantees, tested at the seam where a decision becomes a
 * call into the operating system (CLAUDE.md §5.16, §7 B9, §9).
 *
 * The pure decisions are covered in `src/domain/launch`. What is proved here is
 * the part that can only go wrong once the shell is involved: that a refusal
 * really does mean nothing was opened, that a document and a URL take different
 * calls, and that **every** outcome — opened, refused, failed — lands in the
 * ledger. Rule 9 makes the row mandatory, and a row written only on success
 * would be a flattering record rather than a true one.
 */

import { describe, expect, it } from "vitest";



import type { AuditEntry } from "../src/domain/audit/ledger";
import { AUDIT_ACTIONS } from "../src/domain/audit/ledger";
import { parseLaunchTargets, type LaunchTarget } from "../src/domain/launch/target";
import { Launcher, targetsFor } from "../src/services/launcher";

/** Indexing under `noUncheckedIndexedAccess`: fail loudly rather than on undefined. */
function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined) throw new Error(`expected at least one ${what}`);
  return first;
}

/** The nth item, with the same guarantee. */
function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`expected an item at ${index}`);
  return found;
}


function target(entry: Record<string, unknown>): LaunchTarget {
  const { targets, problems } = parseLaunchTargets({ targets: [entry] });
  expect(problems, JSON.stringify(problems)).toEqual([]);
  return only(targets, "target");
}

const EDATA = target({
  id: "edata",
  kind: "url",
  applies_to: "scdb-request",
  template: "https://edata.example.org/request/{external_ref}",
  field: "external_ref",
  pattern: "^[A-Za-z0-9-]{3,40}$",
});

const SOPS = target({
  id: "sops",
  kind: "file",
  root: "C:\\SOPs",
  field: "artefact_path",
  extensions: ["pdf"],
});

const SOP_FOLDER = target({ id: "sop-folder", kind: "folder", root: "C:\\SOPs" });

interface Harness {
  launcher: Launcher;
  opened: string[];
  externals: string[];
  rows: AuditEntry[];
}

/** `realpath` is faked by a map, so the tests never touch a real filesystem. */
function harness(
  options: {
    enabled?: boolean;
    real?: Record<string, string>;
    openPathFails?: string;
    noShell?: boolean;
  } = {},
): Harness {
  const opened: string[] = [];
  const externals: string[] = [];
  const rows: AuditEntry[] = [];
  const notices: string[] = [];
  const real = options.real ?? {};

  const launcher = new Launcher({
    audit: {
      append: async (entries) => {
        rows.push(...entries);
      },
    },
    actor: () => "yh",
    notify: (message: string) => {
      notices.push(message);
    },
    now: () => "2026-08-30T09:00",
    enabled: () => options.enabled !== false,
    shell: options.noShell === true
      ? null
      : {
          openExternal: async (url: string) => {
            externals.push(url);
          },
          openPath: async (path: string) => {
            opened.push(path);
            return options.openPathFails ?? "";
          },
        },
    realpath: async (path: string) => {
      const hit = real[path];
      if (hit === undefined) throw new Error("ENOENT");
      return hit;
    },
  });

  return { launcher, opened, externals, rows };
}

describe("the ledger action exists and is spelled the way §5.6 names it", () => {
  it("is one of the declared actions", () => {
    expect(AUDIT_ACTIONS).toContain("external-open");
  });
});

describe("opening a URL", () => {
  it("goes through openExternal and never through openPath", () => {
    return (async () => {
      const h = harness();
      const result = await h.launcher.open(EDATA, "EDR-2026-00871", "REQ-2026-014");
      expect(result).toEqual({
        ok: true,
        destination: "https://edata.example.org/request/EDR-2026-00871",
      });
      expect(h.externals).toEqual(["https://edata.example.org/request/EDR-2026-00871"]);
      expect(h.opened).toEqual([]);
    })();
  });

  it("refuses a bad field and opens nothing at all", async () => {
    const h = harness();
    const result = await h.launcher.open(EDATA, "../../admin", "REQ-2026-014");
    expect(result.ok).toBe(false);
    expect(h.externals).toEqual([]);
    expect(h.opened).toEqual([]);
  });
});

describe("opening a document", () => {
  it("resolves the path, then opens the resolved one", async () => {
    const h = harness({ real: { "C:\\SOPs\\DUA-018.pdf": "C:\\SOPs\\real\\DUA-018.pdf" } });
    const result = await h.launcher.open(SOPS, "DUA-018.pdf", "REQ-2026-014");
    expect(result).toEqual({ ok: true, destination: "C:\\SOPs\\real\\DUA-018.pdf" });
    expect(h.opened).toEqual(["C:\\SOPs\\real\\DUA-018.pdf"]);
  });

  it("refuses when the junction leads out of the root", async () => {
    // The string in the note is impeccable; the filesystem disagrees. This is
    // the case no amount of string checking finds, and the reason `realpath`
    // runs before the decision rather than after it.
    const h = harness({ real: { "C:\\SOPs\\DUA-018.pdf": "C:\\Windows\\Temp\\DUA-018.pdf" } });
    const result = await h.launcher.open(SOPS, "DUA-018.pdf", "REQ-2026-014");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("outside C:\\SOPs");
    expect(h.opened).toEqual([]);
  });

  it("refuses a document that resolves to an executable", async () => {
    const h = harness({ real: { "C:\\SOPs\\report.pdf": "C:\\SOPs\\report.pdf.exe" } });
    const result = await h.launcher.open(SOPS, "report.pdf", "REQ-2026-014");
    expect(result.ok).toBe(false);
    expect(h.opened).toEqual([]);
  });

  it("does not say whether a path is missing or forbidden", async () => {
    // Which of the two it is answers a question about the share that this
    // plugin has no business answering.
    const h = harness({ real: {} });
    const result = await h.launcher.open(SOPS, "gone.pdf", "REQ-2026-014");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.why).toContain("nothing readable");
      expect(result.why).not.toContain("permission");
    }
  });

  it("reports a shell failure rather than claiming success", async () => {
    const h = harness({
      real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\a.pdf" },
      openPathFails: "No application is associated with this file",
    });
    const result = await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("No application is associated");
  });
});

describe("opening a folder", () => {
  it("opens the root with nothing from the note", async () => {
    const h = harness({ real: { "C:\\SOPs": "C:\\SOPs" } });
    const result = await h.launcher.open(SOP_FOLDER, "", "REQ-2026-014");
    expect(result).toEqual({ ok: true, destination: "C:\\SOPs" });
    expect(h.opened).toEqual(["C:\\SOPs"]);
  });
});

describe("every outcome reaches the ledger", () => {
  it("logs an opened launch with the resolved destination", async () => {
    const h = harness({ real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\a.pdf" } });
    await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    expect(h.rows).toHaveLength(1);
    expect(only(h.rows, "ledger row")).toMatchObject({
      actor: "yh",
      action: "external-open",
      subject: "REQ-2026-014",
    });
    expect(only(h.rows, "ledger row").detail).toContain("opened: C:\\SOPs\\a.pdf");
  });

  it("logs a refusal too, which is the row worth having", async () => {
    const h = harness({ real: { "C:\\SOPs\\a.pdf": "C:\\Windows\\a.pdf" } });
    await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    expect(h.rows).toHaveLength(1);
    expect(only(h.rows, "ledger row").detail).toContain("refused");
    expect(only(h.rows, "ledger row").detail).toContain("outside");
  });

  it("logs a launch refused before the filesystem was ever consulted", async () => {
    const h = harness();
    await h.launcher.open(EDATA, "../../admin", "REQ-2026-014");
    expect(h.rows).toHaveLength(1);
    expect(only(h.rows, "ledger row").detail).toContain("refused");
  });

  it("logs a shell failure as a failure, not as an open", async () => {
    const h = harness({
      real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\a.pdf" },
      openPathFails: "boom",
    });
    await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    expect(only(h.rows, "ledger row").detail).toContain("failed: boom");
    expect(only(h.rows, "ledger row").detail).not.toContain("opened:");
  });

  it("names the target and its kind in every row", async () => {
    const h = harness({ real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\a.pdf" } });
    await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    await h.launcher.open(EDATA, "EDR-1", "REQ-2026-014");
    expect(only(h.rows, "ledger row").detail.startsWith("sops (file)")).toBe(true);
    expect(at(h.rows, 1).detail.startsWith("edata (url)")).toBe(true);
  });
});

describe("switched off, and unavailable", () => {
  it("opens nothing when the setting is off", async () => {
    const h = harness({ enabled: false });
    const result = await h.launcher.open(EDATA, "EDR-1", "REQ-2026-014");
    expect(result.ok).toBe(false);
    expect(h.externals).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("degrades to a sentence when there is no shell at all", async () => {
    const h = harness({ noShell: true });
    const result = await h.launcher.open(EDATA, "EDR-1", "REQ-2026-014");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain("No handler is available");
  });
});

describe("resolve and open agree on the destination", () => {
  it("previews exactly what open will use, so the dialog cannot lie", async () => {
    const h = harness({ real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\real\\a.pdf" } });
    const preview = await h.launcher.resolve(SOPS, "a.pdf");
    const opened = await h.launcher.open(SOPS, "a.pdf", "REQ-2026-014");
    expect(preview).toEqual(opened);
    expect(h.opened).toEqual(["C:\\SOPs\\real\\a.pdf"]);
  });

  it("previewing does not open anything or write a row", async () => {
    const h = harness({ real: { "C:\\SOPs\\a.pdf": "C:\\SOPs\\a.pdf" } });
    await h.launcher.resolve(SOPS, "a.pdf");
    expect(h.opened).toEqual([]);
    expect(h.rows).toEqual([]);
  });
});

describe("which targets a note is offered", () => {
  it("matches on note type, and an unscoped target offers itself anywhere", () => {
    const anywhere = target({ id: "any", kind: "folder", root: "C:\\SOPs" });
    expect(targetsFor([EDATA, anywhere], "scdb-request").map((t) => t.id)).toEqual([
      "edata",
      "any",
    ]);
    expect(targetsFor([EDATA, anywhere], "publication").map((t) => t.id)).toEqual(["any"]);
  });
});
