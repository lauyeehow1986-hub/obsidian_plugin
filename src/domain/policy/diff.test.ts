import { describe, expect, it } from "vitest";
import {
  changedSections,
  clauseChanged,
  diffPolicy,
  droppedClauses,
  LINE_CAP,
} from "./diff";

const V1 = [
  "# 1 Purpose",
  "",
  "To govern the release of data.",
  "",
  "## 5.1 Internal use",
  "",
  "Internal use is permitted.",
  "",
  "## 5.2 Onward transfer",
  "",
  "Onward transfer requires a signed DUA.",
].join("\n");

const V2 = [
  "# 1 Purpose",
  "",
  "To govern the release of data.",
  "",
  "## 5.1 Internal use",
  "",
  "Internal use is permitted.",
  "",
  "## 5.2 Onward transfer",
  "",
  "Onward transfer requires a signed DUA countersigned by the data custodian.",
].join("\n");

describe("diffPolicy", () => {
  it("attributes a change to the clause it happened in", () => {
    const diff = diffPolicy(V1, V2);
    const changed = changedSections(diff);
    expect(changed.map((section) => section.clause)).toEqual(["5.2"]);
    expect(changed[0]?.addedLines).toBe(1);
    expect(changed[0]?.removedLines).toBe(1);
  });

  it("leaves the untouched clauses alone", () => {
    const diff = diffPolicy(V1, V2);
    const untouched = diff.sections.filter((section) => section.kind === "unchanged");
    expect(untouched.map((section) => section.clause)).toEqual(["1", "5.1"]);
  });

  it("calls an identical document identical", () => {
    const diff = diffPolicy(V1, V1);
    expect(diff.identical).toBe(true);
    expect(changedSections(diff)).toEqual([]);
  });

  it("calls a line-ending re-export identical, because it is", () => {
    expect(diffPolicy(V1, `${V1.replace(/\n/g, "\r\n")}\r\n\r\n`).identical).toBe(true);
  });

  it("separates a re-export from a revision", () => {
    // Same words, re-indented and re-spaced by a word processor. Reporting
    // this as a revision is how people learn to click through the impact map.
    const reexported = V1.split("\n")
      .map((line) => (line.trim() === "" ? "" : `   ${line}  `))
      .join("\n\n");
    const diff = diffPolicy(V1, reexported);
    expect(diff.identical).toBe(false);
    expect(diff.whitespaceOnly).toBe(true);
  });

  it("treats a renamed heading as a change even when nothing beneath it moved", () => {
    const renamed = V1.replace("5.2 Onward transfer", "5.2 Onward transfer (prohibited)");
    const changed = changedSections(diffPolicy(V1, renamed));
    expect(changed.map((section) => section.clause)).toEqual(["5.2"]);
  });

  it("reports a new clause as added", () => {
    const withNew = `${V1}\n\n## 5.3 Retention\n\nDestroy after five years.`;
    const changed = changedSections(diffPolicy(V1, withNew));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ clause: "5.3", kind: "added", addedLines: 1 });
  });

  it("reports a deleted clause as removed, and lists it as dropped", () => {
    const without = V1.replace("\n\n## 5.2 Onward transfer\n\nOnward transfer requires a signed DUA.", "");
    const diff = diffPolicy(V1, without);
    expect(changedSections(diff).map((section) => section.kind)).toEqual(["removed"]);
    expect(droppedClauses(diff)).toEqual(["5.2"]);
  });

  it("counts every changed line across the document", () => {
    const diff = diffPolicy(V1, V2);
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
  });

  it("caps the lines it lists and says how many it left out", () => {
    const before = ["## 5.2 Onward transfer", "", ...Array.from({ length: 200 }, (_, i) => `old ${i}`)];
    const after = ["## 5.2 Onward transfer", "", ...Array.from({ length: 200 }, (_, i) => `new ${i}`)];
    const [section] = changedSections(diffPolicy(before.join("\n"), after.join("\n")));
    expect(section?.lines).toHaveLength(LINE_CAP);
    expect(section?.omitted).toBe(400 - LINE_CAP);
    expect(section?.addedLines).toBe(200);
    expect(section?.removedLines).toBe(200);
  });

  it("ignores a paragraph merely re-indented", () => {
    const indented = V1.replace(
      "Onward transfer requires a signed DUA.",
      "   Onward transfer requires a signed DUA.   ",
    );
    expect(diffPolicy(V1, indented).whitespaceOnly).toBe(true);
  });
});

describe("clauseChanged", () => {
  it("answers for the clause itself and for a subclause of it", () => {
    const diff = diffPolicy(V1, V2);
    expect(clauseChanged(diff, "5.2")).toBe(true);
    expect(clauseChanged(diff, "5.2.1")).toBe(true);
    expect(clauseChanged(diff, "5.1")).toBe(false);
  });
});
