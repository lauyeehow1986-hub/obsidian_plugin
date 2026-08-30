import { describe, expect, it } from "vitest";

import {
  buildUrl,
  containmentProblem,
  decideFile,
  extensionOf,
  fieldProblem,
  joinUnderRoot,
  launchSchemeAllowed,
  normaliseForCompare,
  relativePathProblem,
} from "./resolve";
import { parseLaunchTargets, type LaunchTarget } from "./target";

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
  template: "https://edata.example.org/request/{external_ref}",
  field: "external_ref",
  pattern: "^[A-Za-z0-9-]{3,40}$",
});

const SOPS = target({
  id: "sops",
  kind: "file",
  root: "\\\\fileserver\\SOPs",
  extensions: ["pdf", "docx"],
});

const SOP_FOLDER = target({ id: "sop-folder", kind: "folder", root: "C:\\SOPs" });

describe("the note's one field", () => {
  it("accepts a value matching the target's pattern", () => {
    expect(fieldProblem(EDATA, "EDR-2026-00871")).toBeNull();
  });

  it("refuses an empty field, naming it", () => {
    expect(fieldProblem(EDATA, "   ")).toContain("external_ref is empty");
  });

  it("refuses a line break rather than escaping it", () => {
    // Same rule as §5.11 rule 3 for addresses: a value we cannot vouch for is
    // not a value.
    expect(fieldProblem(EDATA, "EDR-1\r\nX")).toContain("line break");
  });

  it("refuses traversal and query injection in the substituted part", () => {
    for (const value of ["../../admin", "x?redirect=evil.example", "a/b", "x&y"]) {
      expect(fieldProblem(EDATA, value), value).not.toBeNull();
    }
  });

  it("falls back to a narrow default when the config sets no pattern", () => {
    const loose = target({ id: "l", kind: "url", template: "https://e.example.org/{ref}", field: "ref" });
    expect(fieldProblem(loose, "REQ-2026-014")).toBeNull();
    expect(fieldProblem(loose, "../etc")).not.toBeNull();
    expect(fieldProblem(loose, "a b")).not.toBeNull();
  });
});

describe("the relative path a note supplies for a file target", () => {
  it("accepts an ordinary relative path", () => {
    for (const value of ["DUA-2026-018.pdf", "2026/Q3/DUA-018.pdf", "sub\\a.docx"]) {
      expect(relativePathProblem(value), value).toBeNull();
    }
  });

  it("refuses climbing out of the folder", () => {
    expect(relativePathProblem("../../Windows/System32/x.pdf")).toContain("climb out");
    expect(relativePathProblem("a\\..\\..\\b.pdf")).toContain("climb out");
  });

  it("refuses an absolute path or a share, which would ignore the root entirely", () => {
    expect(relativePathProblem("\\\\other\\share\\x.pdf")).toContain("root of a drive");
    expect(relativePathProblem("/etc/passwd")).toContain("root of a drive");
    expect(relativePathProblem("D:\\x.pdf")).toContain("drive");
  });

  it("refuses an NTFS alternate data stream", () => {
    // `x.pdf:evil.exe` is a real file hiding behind a document's name, and it
    // is not a path we have any reason to construct.
    expect(relativePathProblem("x.pdf:evil.exe")).toContain("alternate data stream");
  });

  it("refuses control characters and absurd lengths", () => {
    expect(relativePathProblem("a\u0000b.pdf")).toContain("control character");
    expect(relativePathProblem(`${"a".repeat(300)}.pdf`)).toContain("too long");
  });

  it("joins under the root with one separator, whichever way the note spelled it", () => {
    expect(joinUnderRoot("C:\\SOPs\\", "2026/Q3/a.pdf")).toBe("C:\\SOPs\\2026\\Q3\\a.pdf");
    expect(joinUnderRoot("\\\\fs\\SOPs", "a.pdf")).toBe("\\\\fs\\SOPs\\a.pdf");
  });

  it("is not trusted on its own — containment still runs on the resolved path", () => {
    // A junction inside the root pointing out of it passes every string check
    // there is. This is why decideFile takes a *resolved* path.
    const escaped = decideFile(SOPS, "C:\\Windows\\Temp\\x.pdf");
    expect(escaped.ok).toBe(false);
  });
});

describe("building the URL", () => {
  it("substitutes the value and nothing else", () => {
    expect(buildUrl(EDATA, "EDR-2026-00871")).toEqual({
      ok: true,
      destination: "https://edata.example.org/request/EDR-2026-00871",
    });
  });

  it("percent-encodes the value, never the template", () => {
    const wide = target({
      id: "w",
      kind: "url",
      template: "https://e.example.org/find/{q}",
      field: "q",
      pattern: "^[A-Za-z0-9 /]+$",
    });
    const built = buildUrl(wide, "a b/c");
    expect(built).toEqual({ ok: true, destination: "https://e.example.org/find/a%20b%2Fc" });
  });

  it("refuses rather than launching when the field is wrong", () => {
    const built = buildUrl(EDATA, "../../admin");
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.why).toContain("does not match");
  });

  it("checks the allowlist on the built string, not on the parts", () => {
    expect(launchSchemeAllowed("https://edata.example.org/x")).toBe(true);
    for (const url of [
      "http://edata.example.org/x",
      "file:///C:/x",
      "msteams:/l/chat",
      "https:///nohost",
      "https://a.example.org/x\r\nHost: b",
    ]) {
      expect(launchSchemeAllowed(url), url).toBe(false);
    }
  });
});

describe("comparing two Windows paths", () => {
  it("folds case, separators and trailing slashes", () => {
    expect(normaliseForCompare("C:/SOPs/Sub/")).toBe("c:\\sops\\sub");
    expect(normaliseForCompare("C:\\\\SOPs\\\\Sub")).toBe("c:\\sops\\sub");
  });

  it("keeps the leading double backslash of a UNC path", () => {
    // Collapsing it would turn a network share into a local root and silently
    // change what containment means.
    expect(normaliseForCompare("\\\\fileserver\\SOPs")).toBe("\\\\fileserver\\sops");
  });
});

describe("containment, the check a naive startsWith gets wrong", () => {
  it("allows the root itself and anything under it", () => {
    expect(containmentProblem("C:\\SOPs", "C:\\SOPs")).toBeNull();
    expect(containmentProblem("C:\\SOPs", "C:\\SOPs\\a\\b.pdf")).toBeNull();
    expect(containmentProblem("C:\\SOPs", "c:/sops/A/B.PDF")).toBeNull();
  });

  it("refuses a sibling whose name merely starts with the root", () => {
    // C:\SOPs-archive-public is a different folder with different permissions.
    const why = containmentProblem("C:\\SOPs", "C:\\SOPs-archive-public\\x.pdf");
    expect(why).toContain("outside");
  });

  it("refuses an escape, however it is spelled", () => {
    for (const path of [
      "C:\\Windows\\System32\\x.pdf",
      "D:\\SOPs\\x.pdf",
      "\\\\other\\SOPs\\x.pdf",
    ]) {
      expect(containmentProblem("C:\\SOPs", path), path).not.toBeNull();
    }
  });
});

describe("deciding on a resolved path", () => {
  it("opens a document under the root", () => {
    expect(decideFile(SOPS, "\\\\fileserver\\SOPs\\DUA-2026-018.pdf")).toEqual({
      ok: true,
      destination: "\\\\fileserver\\SOPs\\DUA-2026-018.pdf",
    });
  });

  it("takes the extension from the resolved path, which is the whole point", () => {
    // A note may say `report.pdf`; if that resolves to report.pdf.exe, the
    // check on the string in the note would pass and this one does not.
    const decision = decideFile(SOPS, "\\\\fileserver\\SOPs\\report.pdf.exe");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toContain("runs when it is opened");
  });

  it("refuses containment before it looks at the extension", () => {
    const decision = decideFile(SOPS, "C:\\Users\\me\\Downloads\\x.pdf");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toContain("outside \\\\fileserver\\SOPs");
  });

  it("refuses an extension the target does not list", () => {
    const decision = decideFile(SOPS, "\\\\fileserver\\SOPs\\notes.txt");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toContain(".pdf, .docx");
  });

  it("refuses a file with no extension at all", () => {
    const decision = decideFile(SOPS, "\\\\fileserver\\SOPs\\README");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toContain("no extension");
  });

  it("lets a folder skip the extension check, because opening one runs nothing", () => {
    expect(decideFile(SOP_FOLDER, "C:\\SOPs\\2026")).toEqual({
      ok: true,
      destination: "C:\\SOPs\\2026",
    });
  });

  it("still holds a folder to its root", () => {
    expect(decideFile(SOP_FOLDER, "C:\\Windows").ok).toBe(false);
  });
});

describe("extensionOf", () => {
  it("reads the last extension, lowercased", () => {
    expect(extensionOf("C:\\a\\b.PDF")).toBe("pdf");
    expect(extensionOf("C:\\a\\report.pdf.exe")).toBe("exe");
    expect(extensionOf("\\\\s\\share\\x.tar.gz")).toBe("gz");
  });

  it("is empty for a dotfile or a bare name, so neither opens", () => {
    expect(extensionOf("C:\\a\\.gitignore")).toBe("");
    expect(extensionOf("C:\\a\\README")).toBe("");
  });
});
