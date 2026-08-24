import { describe, expect, it } from "vitest";
import {
  noteDependencyEdges,
  normaliseClause,
  parsePolicy,
  policyLabel,
  refMatchesPolicy,
  statusLabel,
  versionInForceOn,
} from "./policy";

const PATH = "40 Policies/POL-DATA-REL-02.md";

function policy(overrides: Record<string, unknown> = {}) {
  return parsePolicy(PATH, {
    type: "policy",
    id: "POL-DATA-REL-02",
    title: "Release of data to external collaborators",
    authority: "[[30 People/Data Governance Office|DGO]]",
    scope: "institutional",
    status: "current",
    version: "4",
    effective: "2026-07-01",
    review_due: "2027-07-01",
    ...overrides,
  });
}

describe("parsePolicy", () => {
  it("reads the register fields", () => {
    const note = policy();
    expect(note.id).toBe("POL-DATA-REL-02");
    expect(note.scope).toBe("institutional");
    expect(note.status).toBe("current");
    expect(note.authority?.name).toBe("Data Governance Office");
    expect(note.problems).toEqual([]);
  });

  it("keeps the version as text, because real ones are not numbers", () => {
    expect(policy({ version: "2026-A" }).version).toBe("2026-A");
    expect(policy({ version: 3 }).version).toBe("3");
  });

  it("says so when there is no version to file a frozen copy under", () => {
    const note = policy({ version: "" });
    expect(note.problems.join(" ")).toContain("cannot be frozen");
  });

  it("reports an unrecognised scope or status rather than coercing it", () => {
    const note = policy({ scope: "global", status: "live" });
    expect(note.scope).toBe("");
    expect(note.status).toBe("");
    expect(note.problems).toHaveLength(2);
  });

  it("reads an edge written the long way", () => {
    const note = policy({
      governs: [
        { what: "gate", ref: "edata-request:extraction", clause: "§5.2.", note: "the DUA gate" },
      ],
    });
    expect(note.governs).toEqual([
      {
        kind: "gate",
        ref: "edata-request:extraction",
        label: "edata-request:extraction",
        clause: "5.2",
        note: "the DUA gate",
        declaredBy: PATH,
      },
    ]);
  });

  it("accepts a bare link, because that is what somebody will type", () => {
    const note = policy({ derives_from: "[[40 Policies/POL-UPSTREAM]]" });
    expect(note.derivesFrom).toHaveLength(1);
    expect(note.derivesFrom[0]).toMatchObject({ kind: "policy", label: "POL-UPSTREAM", clause: "" });
  });

  it("files an unknown edge kind under other and says it did", () => {
    const note = policy({ governs: [{ what: "consent-form", ref: "[[X]]" }] });
    expect(note.governs[0]?.kind).toBe("other");
    expect(note.problems.join(" ")).toContain("consent-form");
  });

  it("drops an edge with nothing to point at, and says why", () => {
    const note = policy({ governs: [{ what: "form", clause: "5.2" }] });
    expect(note.governs).toEqual([]);
    expect(note.problems.join(" ")).toContain("no `ref`");
  });

  it("orders revisions newest freeze first", () => {
    const note = policy({
      revisions: [
        { version: "2", frozen: "a.md", on: "2025-01-01" },
        { version: "3", frozen: "b.md", on: "2026-01-01" },
      ],
    });
    expect(note.revisions.map((revision) => revision.version)).toEqual(["3", "2"]);
  });

  it("refuses a revision record that names no frozen copy", () => {
    const note = policy({ revisions: [{ version: "3" }] });
    expect(note.revisions).toEqual([]);
    expect(note.problems.join(" ")).toContain("no frozen copy");
  });
});

describe("normaliseClause", () => {
  it.each(["5.2", "§5.2", "clause 5.2", "Section 5.2.", " 5.2 "])("reads %s as 5.2", (raw) => {
    expect(normaliseClause(raw)).toBe("5.2");
  });
});

describe("noteDependencyEdges", () => {
  it("gives an edge the kind of the note that declared it", () => {
    const edges = noteDependencyEdges("88 Forms/FORM-consent.md", "redcap-form", {
      derives_from: [{ ref: "[[POL-DATA-REL-02]]", clause: "5.2" }],
    });
    expect(edges[0]).toMatchObject({ kind: "form", clause: "5.2", declaredBy: "88 Forms/FORM-consent.md" });
  });

  it("returns nothing for a note that declares nothing", () => {
    expect(noteDependencyEdges("x.md", "capture", {})).toEqual([]);
  });
});

describe("refMatchesPolicy", () => {
  const note = policy();

  it.each([
    "[[POL-DATA-REL-02]]",
    "[[40 Policies/POL-DATA-REL-02]]",
    "[[40 Policies/POL-DATA-REL-02|the release policy]]",
    "POL-DATA-REL-02",
  ])("matches %s", (ref) => {
    expect(refMatchesPolicy(ref, note)).toBe(true);
  });

  it("does not match a different policy", () => {
    expect(refMatchesPolicy("[[POL-OTHER]]", note)).toBe(false);
  });

  it("matches nothing on an empty ref", () => {
    expect(refMatchesPolicy("", note)).toBe(false);
  });
});

describe("versionInForceOn", () => {
  const AFTER = Date.parse("2026-09-01T00:00:00Z");
  const BEFORE = Date.parse("2026-02-01T00:00:00Z");

  it("answers with the live note once its effective date has passed", () => {
    const answer = versionInForceOn(policy(), AFTER);
    expect(answer).toMatchObject({ version: "4", path: PATH, live: true });
  });

  it("reaches back to the frozen copy for an earlier date", () => {
    const note = policy({
      revisions: [{ version: "3", frozen: "40 Policies/_revisions/POL@3.md", on: "2025-06-01" }],
    });
    const answer = versionInForceOn(note, BEFORE);
    expect(answer).toMatchObject({ version: "3", path: "40 Policies/_revisions/POL@3.md", live: false });
  });

  it("says it cannot tell rather than guessing", () => {
    // The honest answer when nothing was frozen before the date asked about.
    const answer = versionInForceOn(policy(), BEFORE);
    expect(answer.version).toBe("");
    expect(answer.note).toContain("cannot say");
  });

  it("flags an answer given without an effective date", () => {
    const answer = versionInForceOn(policy({ effective: undefined }), AFTER);
    expect(answer.live).toBe(true);
    expect(answer.note).toContain("not a dated answer");
  });
});

describe("labels", () => {
  it("names a policy by id and title", () => {
    expect(policyLabel(policy())).toBe(
      "POL-DATA-REL-02 — Release of data to external collaborators",
    );
  });

  it("falls back to whatever the note has", () => {
    expect(policyLabel(policy({ id: "", title: "" }))).toBe(PATH);
  });

  it("says a status is unstated rather than showing nothing", () => {
    expect(statusLabel("")).toBe("Unstated");
    expect(statusLabel("current")).toBe("In force");
  });
});
