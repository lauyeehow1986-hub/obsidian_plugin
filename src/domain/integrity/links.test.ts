import { describe, expect, it } from "vitest";
import {
  checkIntegrity,
  describeFindings,
  frontmatterLinks,
  summariseIntegrity,
  type IntegrityInput,
  type IntegrityNote,
} from "./links";

const UID_A = "01JZR5B1QK4N8ZXC6TFHJD2VWM";
const UID_B = "01JZR5B1QK4N8ZXC6TFHJD2VWN";

const note = (
  path: string,
  frontmatter: Record<string, unknown>,
  type = "scdb-request",
): IntegrityNote => ({ path, type, frontmatter });

function run(notes: IntegrityNote[], overrides: Partial<IntegrityInput> = {}) {
  return checkIntegrity({
    notes,
    resolve: () => null,
    folderFor: () => "",
    ledgerSubjects: [],
    uidTypes: ["scdb-request"],
    ...overrides,
  });
}

describe("frontmatterLinks", () => {
  it("finds links in strings, arrays and nested mappings", () => {
    const found = frontmatterLinks({
      requester: "[[Dr A Tan]]",
      authors: ["[[Dr A Tan]]", "[[Owner]]"],
      evidence: [{ by: "[[DSRB]]", on: "2026-03-04" }],
      title: "no link here",
    });
    expect(found).toEqual([
      { field: "requester", target: "Dr A Tan" },
      { field: "authors", target: "Dr A Tan" },
      { field: "authors", target: "Owner" },
      { field: "evidence", target: "DSRB" },
    ]);
  });

  it("strips an alias and a heading from the target", () => {
    expect(frontmatterLinks({ a: "[[People/Dr A Tan|Tan]]" })[0]?.target).toBe("People/Dr A Tan");
    expect(frontmatterLinks({ a: "[[Policy#Section 3]]" })[0]?.target).toBe("Policy");
  });

  it("ignores brackets that are not links", () => {
    expect(frontmatterLinks({ a: "[not a link]", b: "[[]]" })).toEqual([]);
  });
});

describe("unresolved links", () => {
  it("reports a link with no note behind it", () => {
    const findings = run([note("10 Requests/REQ-1.md", { uid: UID_A, requester: "[[Dr A Tan]]" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unresolved-link");
    expect(findings[0]?.subject).toBe("Dr A Tan");
  });

  it("says nothing about a link that resolves", () => {
    const findings = run([note("a.md", { uid: UID_A, requester: "[[Dr A Tan]]" })], {
      resolve: () => "30 People/Dr A Tan.md",
    });
    expect(findings).toHaveLength(0);
  });

  it("offers to create the missing note where the field says where it belongs", () => {
    // The one repair this module offers: additive, reversible, and exactly what
    // an unresolved [[Dr A Tan]] is asking for.
    const findings = run([note("a.md", { uid: UID_A, requester: "[[Dr A Tan]]" })], {
      folderFor: (field) => (field === "requester" ? "30 People" : ""),
    });
    expect(findings[0]?.repair).toEqual({
      kind: "create-note",
      path: "30 People/Dr A Tan.md",
      title: "Dr A Tan",
    });
  });

  it("reports one finding per missing note, not one per link to it", () => {
    // A request names the same person in requester, blocked_on, an evidence
    // record and two history entries. Five rows saying the same thing would
    // bury the twenty other notes with the same gap.
    const findings = run([
      note("a.md", {
        uid: UID_A,
        requester: "[[Dr A Tan]]",
        blocked_on: "[[Dr A Tan]]",
        evidence: [{ by: "[[Dr A Tan]]" }],
        history: [{ blocked_on: "[[Dr A Tan]]" }],
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "`requester`, `blocked_on`, `evidence`, `history` link to [[Dr A Tan]], which is not a note in this vault.",
    );
  });

  it("takes the folder from a field that knows one, ignoring those that do not", () => {
    // `history` records what was true; it cannot say where a note lives now.
    const findings = run(
      [note("a.md", { uid: UID_A, history: "[[Dr A Tan]]", requester: "[[Dr A Tan]]" })],
      { folderFor: (field) => (field === "requester" ? "30 People" : "") },
    );
    expect(findings[0]?.repair?.path).toBe("30 People/Dr A Tan.md");
  });

  it("offers no repair when we cannot tell where the note belongs", () => {
    const findings = run([note("a.md", { uid: UID_A, whatever: "[[Something]]" })]);
    expect(findings[0]?.repair).toBeUndefined();
  });
});

describe("identity", () => {
  it("reports two notes claiming one uid", () => {
    // §5.2: a uid is immutable and never reused, so this means a note was
    // copied and every machine reference to it is now ambiguous.
    const findings = run([note("a.md", { uid: UID_A }), note("b.md", { uid: UID_A })]);
    expect(findings.map((f) => f.kind)).toEqual(["duplicate-uid"]);
    expect(findings[0]?.message).toContain("a.md, b.md");
  });

  it("does not offer to repair a duplicate uid", () => {
    // Which of the two is the impostor is not a question this code can answer.
    const findings = run([note("a.md", { uid: UID_A }), note("b.md", { uid: UID_A })]);
    expect(findings[0]?.repair).toBeUndefined();
  });

  it("reports two notes carrying one id, more gently", () => {
    const findings = run([
      note("a.md", { uid: UID_A, id: "REQ-2026-001" }),
      note("b.md", { uid: UID_B, id: "REQ-2026-001" }),
    ]);
    expect(findings.map((f) => f.kind)).toEqual(["duplicate-id"]);
    expect(findings[0]?.message).toContain("renumbered");
  });

  it("reports a request with no uid at all", () => {
    const findings = run([note("a.md", { id: "REQ-1" })]);
    expect(findings.map((f) => f.kind)).toEqual(["missing-uid"]);
  });

  it("does not demand a uid from a note type that does not carry one", () => {
    expect(run([note("30 People/Dr A Tan.md", { name: "Tan" }, "person")])).toHaveLength(0);
  });
});

describe("uid references", () => {
  it("reports a reference to a uid no note carries", () => {
    const findings = run([note("94 Runs/RUN-1.md", { uid: UID_A, request: UID_B }, "run")], {
      uidTypes: [],
    });
    expect(findings.map((f) => f.kind)).toEqual(["dangling-uid"]);
    expect(findings[0]?.subject).toBe(UID_B);
  });

  it("says nothing when the target exists", () => {
    const findings = run(
      [note("a.md", { uid: UID_A, request: UID_B }), note("b.md", { uid: UID_B })],
      { uidTypes: [] },
    );
    expect(findings).toHaveLength(0);
  });

  it("does not report a note for referencing itself", () => {
    expect(run([note("a.md", { uid: UID_A, self: UID_A })], { uidTypes: [] })).toHaveLength(0);
  });

  it("ignores strings that merely look like identifiers", () => {
    const findings = run(
      [note("a.md", { uid: UID_A, ref: "EDR-2026-00871", other: "VAR-LVEF@2" })],
      { uidTypes: [] },
    );
    expect(findings).toHaveLength(0);
  });
});

describe("ledger reconciliation", () => {
  it("reports a ledger subject with no note behind it", () => {
    const findings = run([note("a.md", { uid: UID_A, id: "REQ-1" })], {
      ledgerSubjects: ["REQ-1", "REQ-9"],
    });
    expect(findings.map((f) => f.subject)).toEqual(["REQ-9"]);
    expect(findings[0]?.kind).toBe("ledger-orphan");
  });

  it("frames it as worth checking, not as damage", () => {
    // The ledger is append-only and records what happened; a deleted request is
    // a fact about history, not corruption.
    const findings = run([], { ledgerSubjects: ["REQ-9"] });
    expect(findings[0]?.message).toContain("Expected if it was deleted");
  });

  it("reports each missing subject once, however many entries name it", () => {
    const findings = run([], { ledgerSubjects: ["REQ-9", "REQ-9", "REQ-9"] });
    expect(findings).toHaveLength(1);
  });
});

describe("ordering and summary", () => {
  it("leads with what actually breaks something", () => {
    const findings = run(
      [
        note("a.md", { uid: UID_A, requester: "[[Nobody]]" }),
        note("b.md", { uid: UID_A }),
        note("c.md", { id: "REQ-1" }),
      ],
      { ledgerSubjects: ["REQ-gone"] },
    );
    expect(findings.map((f) => f.kind)).toEqual([
      "duplicate-uid",
      "missing-uid",
      "ledger-orphan",
      "unresolved-link",
    ]);
  });

  it("collapses many links to one missing note into one repair", () => {
    // Five requests pointing at one missing person is one note to create.
    const notes = ["P", "Q", "R"].map((tail) =>
      note(`${tail}.md`, { uid: UID_A.slice(0, 25) + tail, requester: "[[Dr A Tan]]" }),
    );
    const summary = summariseIntegrity(run(notes, { folderFor: () => "30 People" }));
    expect(summary.total).toBe(3);
    expect(summary.repairs).toEqual([
      { kind: "create-note", path: "30 People/Dr A Tan.md", title: "Dr A Tan" },
    ]);
  });

  it("counts by kind in severity order", () => {
    const summary = summariseIntegrity(
      run([note("a.md", { uid: UID_A, x: "[[One]]", y: "[[Two]]" })]),
    );
    expect(summary.byKind).toEqual([{ kind: "unresolved-link", count: 2 }]);
  });
});

describe("describeFindings", () => {
  it("agrees with itself about number", () => {
    // "1 links to notes that do not exist" shipped once; the report is read by
    // people deciding whether to worry, and sloppy copy reads as sloppy code.
    expect(describeFindings("unresolved-link", 1)).toBe("1 link to a note that does not exist");
    expect(describeFindings("unresolved-link", 3)).toBe("3 links to notes that do not exist");
    expect(describeFindings("duplicate-uid", 1)).toBe("1 note sharing a uid");
  });
});
