import { describe, expect, it } from "vitest";
import { inFlight, parsePublication, publicationsInFlight } from "./publication";

const pub = (overrides: Record<string, unknown> = {}) =>
  parsePublication("85 Publications/PUB-1.md", {
    id: "PUB-2026-007",
    title: "A paper",
    stage: "under-review",
    journal: "European Heart Journal",
    submitted: "2026-04-02",
    decision_due: "2026-08-01",
    scdb_supported: true,
    ...overrides,
  });

describe("parsePublication", () => {
  it("reads the §5.4 fields", () => {
    const p = pub();
    expect(p.id).toBe("PUB-2026-007");
    expect(p.journal).toBe("European Heart Journal");
    expect(p.scdbSupported).toBe(true);
    expect(p.decisionDue).not.toBeNull();
    expect(p.problems).toEqual([]);
  });

  it("keeps an unrecognised stage and reports it rather than coercing", () => {
    // Coercing to a known stage would silently change what the note says.
    const p = pub({ stage: "in-limbo" });
    expect(p.stage).toBe("in-limbo");
    expect(p.problems[0]).toContain("in-limbo");
  });

  it("reports an unreadable decision date instead of treating it as absent", () => {
    const p = pub({ decision_due: "next Tuesday" });
    expect(p.decisionDue).toBeNull();
    expect(p.problems[0]).toContain("decision_due");
  });

  it("treats anything other than `true` as not SCDB-supported", () => {
    // This number goes in front of a funding committee (§5.4), so "yes" typed
    // as a string does not silently become a claim the facility contributed.
    expect(pub({ scdb_supported: "yes" }).scdbSupported).toBe(false);
    expect(pub({ scdb_supported: undefined }).scdbSupported).toBe(false);
  });

  it("survives a note with nothing in it", () => {
    const p = parsePublication("x.md", {});
    expect(p.id).toBe("");
    expect(p.problems).toEqual([]);
  });
});

describe("in flight", () => {
  it("keeps accepted and in-press on the board", () => {
    // Proofs, embargo and the open-access decision are still outstanding;
    // dropping these is how they get missed.
    expect(inFlight(pub({ stage: "accepted" }))).toBe(true);
    expect(inFlight(pub({ stage: "in-press" }))).toBe(true);
  });

  it("settles published, rejected and shelved", () => {
    for (const stage of ["published", "rejected", "shelved"]) {
      expect(inFlight(pub({ stage }))).toBe(false);
    }
  });

  it("orders by decision due, undated last", () => {
    const list = publicationsInFlight([
      pub({ id: "late", decision_due: "2026-12-01" }),
      pub({ id: "undated", decision_due: undefined, stage: "drafting" }),
      pub({ id: "soon", decision_due: "2026-08-01" }),
      pub({ id: "done", stage: "published" }),
    ]);
    expect(list.map((p) => p.id)).toEqual(["soon", "late", "undated"]);
  });
});

describe("author position, and the key Obsidian takes for itself", () => {
  // Same root cause as the service role in `domain/profile`: the metadata
  // cache overwrites `frontmatter.position`, so an author position typed as
  // `position:` never reaches the parser through the index.
  const base = { type: "publication", id: "PUB-1", title: "T", stage: "published" };

  it("prefers `author_position`", () => {
    expect(parsePublication("p.md", { ...base, author_position: 3, position: 9 }).position).toBe(3);
  });

  it("still reads `position`, which is what §5.4 writes", () => {
    expect(parsePublication("p.md", { ...base, position: 2 }).position).toBe(2);
  });

  it("reports an unreadable one rather than silently dropping it", () => {
    const note = parsePublication("p.md", { ...base, author_position: "third" });
    expect(note.position).toBeNull();
    expect(note.problems.some((problem) => problem.includes("position"))).toBe(true);
  });
});
