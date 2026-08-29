import { describe, expect, it } from "vitest";

import type { Row } from "../query/model";
import { buildSnapshot } from "./snapshot";

const ROWS: Row[] = [
  { key: "10 Requests/REQ-1.md", type: "scdb-request", fields: { id: "REQ-1", stage: "triage" } },
  { key: "10 Requests/REQ-2.md", type: "scdb-request", fields: { id: "REQ-2", subject: "RE: cohort" } },
  {
    key: "75 Correspondence/THR-1.md",
    type: "correspondence",
    fields: { id: "THR-1", subject: "RE: cohort", messages: [{ summary: "Chased." }] },
  },
  { key: "94 Runs/RUN-1.md", type: "run", fields: { id: "RUN-1" } },
];

describe("what an exported app carries with it (§5.13, §5.10)", () => {
  it("includes only the types the app was granted", () => {
    const snapshot = buildSnapshot(ROWS, { types: ["scdb-request"] });
    expect(Object.keys(snapshot.rows)).toEqual(["scdb-request"]);
    expect(snapshot.count).toBe(2);
  });

  it("keeps the note path, so a row can be traced back", () => {
    const snapshot = buildSnapshot(ROWS, { types: ["run"] });
    expect(snapshot.rows.run?.[0]?.path).toBe("94 Runs/RUN-1.md");
  });

  /**
   * §5.10's consequence, made concrete: the vault may hold full message bodies,
   * so an export — a file that travels — does not carry correspondence by
   * default even when the app is granted it.
   */
  describe("correspondence does not leave the vault by default", () => {
    const snapshot = buildSnapshot(ROWS, { types: ["scdb-request", "correspondence"] });

    it("drops correspondence notes entirely", () => {
      expect(snapshot.rows.correspondence).toBeUndefined();
      expect(snapshot.count).toBe(2);
    });

    it("drops correspondence-derived fields from the notes it keeps", () => {
      const request = snapshot.rows["scdb-request"]?.find((row) => row.id === "REQ-2");
      expect(request?.subject).toBeUndefined();
      expect(request?.id).toBe("REQ-2");
    });

    it("says what it left out rather than quietly shrinking the page", () => {
      expect(snapshot.exclusions.join(" ")).toMatch(/1 correspondence note left out/);
      expect(snapshot.exclusions.join(" ")).toMatch(/Fields left out of every row: subject/);
    });
  });

  it("carries correspondence when that is explicitly asked for", () => {
    const snapshot = buildSnapshot(ROWS, {
      types: ["correspondence"],
      includeCorrespondence: true,
    });
    expect(snapshot.rows.correspondence).toHaveLength(1);
    expect(snapshot.exclusions).toEqual([]);
  });

  /** "There are none" is a different fact from "they were removed". */
  it("keeps an empty list for a granted type with no notes", () => {
    const snapshot = buildSnapshot(ROWS, { types: ["run", "publication"] });
    expect(snapshot.rows.publication).toEqual([]);
    expect(snapshot.exclusions).toEqual([]);
  });

  it("drops a dotted field whose head is excluded", () => {
    const snapshot = buildSnapshot(
      [{ key: "a.md", type: "run", fields: { "messages.0.summary": "quoted", id: "RUN-9" } }],
      { types: ["run"] },
    );
    expect(snapshot.rows.run?.[0]).toEqual({ path: "a.md", id: "RUN-9" });
  });
});
