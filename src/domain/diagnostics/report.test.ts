import { describe, expect, it } from "vitest";
import { check, renderReport, summarise, tally, type DiagnosticsReport } from "./report";

const report = (...sections: DiagnosticsReport["sections"]): DiagnosticsReport => ({
  generatedAt: "2026-08-22T14:03",
  sections,
});

describe("tally and summary", () => {
  it("counts every status", () => {
    const r = report({
      title: "S",
      checks: [
        check("a", "ok", "."),
        check("b", "warn", "."),
        check("c", "problem", "."),
        check("d", "unavailable", "."),
      ],
    });
    expect(tally(r)).toEqual({ ok: 1, warn: 1, problem: 1, unavailable: 1 });
  });

  it("leads with problems when there are any", () => {
    const r = report({ title: "S", checks: [check("a", "problem", "."), check("b", "warn", ".")] });
    expect(summarise(r)).toBe("1 problem found, 1 to check.");
  });

  it("says nothing is broken when only warnings remain", () => {
    const r = report({ title: "S", checks: [check("a", "ok", "."), check("b", "warn", ".")] });
    expect(summarise(r)).toBe("Nothing broken; 1 thing to check.");
  });

  it("does not let unavailable checks read as failures", () => {
    // "The interpreter is missing" and "this build cannot look yet" are
    // different facts; collapsing them trains the reader to ignore both.
    const r = report({ title: "S", checks: [check("a", "ok", "."), check("b", "unavailable", ".")] });
    expect(summarise(r)).toBe("All 1 checks passed; 1 not applicable to this build.");
  });
});

describe("renderReport", () => {
  const rendered = renderReport(
    report({
      title: "Encrypted backup",
      checks: [
        check("Destination", "problem", "Not set.", "Set a folder in settings."),
        check("Age", "ok", "Last snapshot was today."),
      ],
    }),
  );

  it("is markdown a person can paste into a message", () => {
    expect(rendered).toContain("# SCDB Cockpit diagnostics");
    expect(rendered).toContain("## Encrypted backup");
    expect(rendered).toContain("| PROBLEM | Destination | Not set. Set a folder in settings. |");
  });

  it("states its own status in words, never a colour or a glyph alone", () => {
    // The report is plain text in a message thread; §6's rule about colour has
    // no meaning there, so the status has to be a word.
    expect(rendered).toMatch(/\| ok \| Age \|/);
    expect(rendered).toContain("PROBLEM");
  });

  it("warns that it names notes, since it does", () => {
    expect(rendered).toContain("It carries no note content.");
  });

  it("stamps when it was generated", () => {
    expect(rendered).toContain("2026-08-22T14:03");
  });

  it("escapes a pipe so one bad value cannot break the table", () => {
    // Details are built from note ids, folder names and error messages, any of
    // which can contain a pipe.
    const out = renderReport(
      report({ title: "S", checks: [check("Spec problems", "problem", "a|b in _config")] }),
    );
    expect(out).toContain("a\\|b in _config");
    expect(out.split("\n").filter((line) => line.startsWith("|"))).toHaveLength(3);
  });

  it("flattens a multi-line detail onto one row", () => {
    const out = renderReport(report({ title: "S", checks: [check("x", "warn", "one\ntwo")] }));
    expect(out).toContain("| one two |");
  });

  it("says so rather than rendering an empty table", () => {
    expect(renderReport(report({ title: "Empty", checks: [] }))).toContain("Nothing to report.");
  });
});
