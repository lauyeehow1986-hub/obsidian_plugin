import { describe, expect, it } from "vitest";
import type { ArchiveFile } from "./archive";
import { utf8 } from "./bytes";
import { describeRestore, planRestore, refusePath } from "./restore";

const file = (path: string, text = "x"): ArchiveFile => ({ path, bytes: utf8(text) });

describe("refusePath", () => {
  it("accepts an ordinary vault path", () => {
    expect(refusePath("10 Requests/REQ-2026-014.md")).toBeNull();
    expect(refusePath("30 People/Zoë.md")).toBeNull();
    expect(refusePath("a.md")).toBeNull();
  });

  it("refuses anything that escapes the vault", () => {
    // A snapshot is a file that travels, so by the time it is read it is
    // untrusted input — refused and named, never normalised into safety.
    expect(refusePath("../outside.md")).toBe("it points outside the vault");
    expect(refusePath("10 Requests/../../x.md")).toBe("it points outside the vault");
    expect(refusePath("./a.md")).toBe("it points outside the vault");
    expect(refusePath("/etc/passwd")).toBe("it is an absolute path");
    expect(refusePath("C:/Windows/system32/x.dll")).toBe("it is an absolute path");
  });

  it("refuses a backslash rather than converting it", () => {
    // Obsidian reports forward slashes everywhere, so one appearing means the
    // file did not come from here — and rewriting it would hide that.
    expect(refusePath("10 Requests\\REQ-1.md")).toBe("it contains a backslash");
  });

  it("refuses control characters and empty names", () => {
    expect(refusePath("a\nb.md")).toBe("it contains a control character");
    expect(refusePath("  ")).toBe("the archive lists a file with no name");
    expect(refusePath("a//b.md")).toBe("it points outside the vault");
  });
});

describe("planRestore", () => {
  it("restores everything into an empty vault", () => {
    const plan = planRestore([file("a.md"), file("b/c.md")], new Set());
    expect(plan.create.map((f) => f.path)).toEqual(["a.md", "b/c.md"]);
    expect(plan.existing).toEqual([]);
    expect(plan.bytes).toBe(2);
  });

  it("never overwrites a file already in the vault", () => {
    // Rule 8. Into a live vault this fills gaps; it cannot undo an edit made
    // since the snapshot was taken.
    const plan = planRestore([file("a.md"), file("b.md")], new Set(["a.md"]));
    expect(plan.create.map((f) => f.path)).toEqual(["b.md"]);
    expect(plan.existing).toEqual(["a.md"]);
  });

  it("quarantines an unsafe path instead of dropping it silently", () => {
    const plan = planRestore([file("../evil.md"), file("ok.md")], new Set());
    expect(plan.create.map((f) => f.path)).toEqual(["ok.md"]);
    expect(plan.refused).toEqual([
      { path: "../evil.md", reason: "it points outside the vault" },
    ]);
  });
});

describe("describeRestore", () => {
  it("says plainly when there is nothing to do", () => {
    const lines = describeRestore(planRestore([file("a.md")], new Set(["a.md"])));
    expect(lines[0]).toMatch(/Nothing to restore/);
  });

  it("names the counts and states that nothing is overwritten", () => {
    const lines = describeRestore(planRestore([file("a.md"), file("b.md")], new Set(["a.md"])));
    expect(lines[0]).toContain("1 file will be created");
    expect(lines[1]).toContain("never overwrites");
  });

  it("summarises refusals without listing hundreds of them", () => {
    const files = ["../1", "../2", "../3", "../4"].map((p) => file(p));
    const lines = describeRestore(planRestore(files, new Set()));
    expect(lines[1]).toContain("4 refused");
    expect(lines[1]).toContain("…");
  });
});
