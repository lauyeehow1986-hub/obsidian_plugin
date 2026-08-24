import { describe, expect, it } from "vitest";
import { buildRegister, indexIncoming } from "./register";
import { parsePolicy, refMatchesPolicy, type PolicyEdge } from "./policy";

const NOW = Date.parse("2026-08-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);

function policy(overrides: Record<string, unknown> = {}) {
  return parsePolicy(`40 Policies/${String(overrides["id"] ?? "POL-A")}.md`, {
    type: "policy",
    id: "POL-A",
    title: "Release",
    status: "current",
    version: "4",
    governs: [{ what: "gate", ref: "edata-request:extraction", clause: "5.2" }],
    revisions: [{ version: "3", frozen: "x.md", on: "2026-01-01" }],
    ...overrides,
  });
}

describe("buildRegister — review state", () => {
  it("puts an overdue review at the top", () => {
    const register = buildRegister({
      policies: [
        policy({ id: "POL-SOON", review_due: iso(10) }),
        policy({ id: "POL-LATE", review_due: iso(-30) }),
        policy({ id: "POL-FAR", review_due: iso(400) }),
      ],
      now: NOW,
    });
    expect(register.rows.map((row) => row.reviewState)).toEqual([
      "overdue",
      "due-soon",
      "scheduled",
    ]);
    expect(register.rows[0]?.reviewInDays).toBe(-30);
  });

  it("distinguishes no review date from a distant one", () => {
    const register = buildRegister({ policies: [policy({ review_due: undefined })], now: NOW });
    expect(register.rows[0]?.reviewState).toBe("unset");
    expect(register.rows[0]?.reviewInDays).toBeNull();
  });

  it("counts the overdue reviews", () => {
    const register = buildRegister({
      policies: [policy({ id: "A", review_due: iso(-1) }), policy({ id: "B", review_due: iso(1) })],
      now: NOW,
    });
    expect(register.summary.overdue).toBe(1);
  });
});

describe("buildRegister — the vault's own gaps", () => {
  it("calls out a policy in force that nothing declares a dependency on", () => {
    // A policy with no declared dependants is not a policy nothing rests on;
    // it is one whose revision will produce an empty impact map.
    const register = buildRegister({ policies: [policy({ governs: [] })], now: NOW });
    expect(register.summary.undeclared).toBe(1);
    expect(register.rows[0]?.problems.join(" ")).toContain("empty impact map");
  });

  it("calls out a policy in force that has never been frozen", () => {
    const register = buildRegister({ policies: [policy({ revisions: [] })], now: NOW });
    expect(register.summary.neverFrozen).toBe(1);
    expect(register.rows[0]?.problems.join(" ")).toContain("nothing to diff against");
  });

  it("does not nag about a superseded policy", () => {
    const register = buildRegister({
      policies: [policy({ status: "superseded", governs: [], revisions: [] })],
      now: NOW,
    });
    expect(register.summary).toMatchObject({ inForce: 0, undeclared: 0, neverFrozen: 0 });
    expect(register.rows[0]?.problems).toEqual([]);
  });

  it("says when a note does not declare whether it is in force", () => {
    const register = buildRegister({ policies: [policy({ status: undefined })], now: NOW });
    expect(register.rows[0]?.problems.join(" ")).toContain("whether this is in force");
  });

  it("counts how many dependants name the clause they rest on", () => {
    const register = buildRegister({
      policies: [
        policy({
          governs: [
            { what: "gate", ref: "g", clause: "5.2" },
            { what: "form", ref: "[[F]]" },
          ],
        }),
      ],
      now: NOW,
    });
    expect(register.rows[0]?.edges).toHaveLength(2);
    expect(register.rows[0]?.withClause).toBe(1);
  });
});

describe("indexIncoming", () => {
  const target = policy();
  const edge: PolicyEdge = {
    kind: "form",
    ref: "[[40 Policies/POL-A|the release policy]]",
    label: "POL-A",
    clause: "5.2",
    note: "",
    declaredBy: "88 Forms/FORM-consent.md",
  };

  it("files an edge under the policy its ref resolves to", () => {
    const index = indexIncoming([target], [edge], refMatchesPolicy);
    expect(index.get(target.path)).toHaveLength(1);
  });

  it("turns the edge round to name the note that declared it", () => {
    // Found on screen: as written, the ref points at the policy, so the
    // policy's own impact map read "POL-DATA-REL-02 depends on
    // POL-DATA-REL-02". What depends on it is the form that wrote the line.
    const [filed] = indexIncoming([target], [edge], refMatchesPolicy).get(target.path)!;
    expect(filed).toMatchObject({
      ref: "[[88 Forms/FORM-consent]]",
      label: "FORM-consent",
      clause: "5.2",
      declaredBy: "88 Forms/FORM-consent.md",
    });
  });

  it("files nothing when the ref points somewhere else", () => {
    const index = indexIncoming([target], [{ ...edge, ref: "[[POL-OTHER]]" }], refMatchesPolicy);
    expect(index.size).toBe(0);
  });

  it("feeds the register, so a dependency declared from the far end still counts", () => {
    const register = buildRegister({
      policies: [policy({ governs: [] })],
      incoming: indexIncoming([target], [edge], refMatchesPolicy),
      now: NOW,
    });
    expect(register.rows[0]?.edges).toHaveLength(1);
    expect(register.summary.undeclared).toBe(0);
  });
});
