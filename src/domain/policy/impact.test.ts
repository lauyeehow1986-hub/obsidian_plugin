import { describe, expect, it } from "vitest";
import { diffPolicy } from "./diff";
import { actionable, buildImpactMap, collectEdges } from "./impact";
import { parsePolicy, type PolicyEdge } from "./policy";

const V1 = [
  "## 5.1 Internal use",
  "",
  "Internal use is permitted.",
  "",
  "## 5.2 Onward transfer",
  "",
  "Onward transfer requires a signed DUA.",
  "",
  "## 5.3 Retention",
  "",
  "Destroy after five years.",
].join("\n");

const V2 = V1.replace(
  "Onward transfer requires a signed DUA.",
  "Onward transfer requires a signed DUA countersigned by the custodian.",
);

const V2_WITHOUT_53 = V2.replace("\n\n## 5.3 Retention\n\nDestroy after five years.", "");

function policy(governs: unknown[]) {
  return parsePolicy("40 Policies/POL-A.md", {
    type: "policy",
    id: "POL-A",
    title: "Release",
    status: "current",
    version: "4",
    governs,
  });
}

describe("buildImpactMap — verdicts", () => {
  it("flags what rests on the clause that changed", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "gate", ref: "edata-request:extraction", clause: "5.2" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(map.rows[0]).toMatchObject({ verdict: "affected" });
    expect(map.rows[0]?.sections).toEqual(["5.2 Onward transfer"]);
    expect(map.rows[0]?.reason).toContain("clause 5.2 changed");
  });

  it("clears what rests on a clause that did not move — and says so", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "form", ref: "[[FORM-consent]]", clause: "5.1" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(map.rows[0]?.verdict).toBe("clear");
    expect(map.rows[0]?.reason).toContain("unchanged");
  });

  it("never clears a dependant that cites no clause", () => {
    // The governance rule of this module: no clause means we do not know, and
    // "we do not know" is not "probably fine".
    const map = buildImpactMap({
      policy: policy([{ what: "policy", ref: "[[SOP extraction]]" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(map.rows[0]?.verdict).toBe("review");
    expect(map.rows[0]?.reason).toContain("cannot be ruled out");
  });

  it("shouts loudest when the clause it rests on has ceased to exist", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "script", ref: "[[SCRIPT-purge]]", clause: "5.3" }]),
      diff: diffPolicy(V1, V2_WITHOUT_53),
    });
    expect(map.rows[0]?.verdict).toBe("clause-gone");
    expect(map.droppedClauses).toEqual(["5.3"]);
  });

  it("reaches a dependant citing a subclause of what changed", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "form", ref: "[[FORM-x]]", clause: "5.2.1" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(map.rows[0]?.verdict).toBe("affected");
  });

  it("clears everything when the revision is whitespace only", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "policy", ref: "[[SOP]]" }]),
      diff: diffPolicy(V1, `${V1.replace(/\n/g, "\r\n")}\r\n`),
    });
    expect(map.rows[0]?.verdict).toBe("clear");
    expect(map.rows[0]?.reason).toContain("whitespace only");
  });
});

describe("buildImpactMap — ordering and grouping", () => {
  const map = buildImpactMap({
    policy: policy([
      { what: "form", ref: "[[FORM-clear]]", clause: "5.1" },
      { what: "policy", ref: "[[SOP-unknown]]" },
      { what: "gate", ref: "edata-request:extraction", clause: "5.2" },
      { what: "script", ref: "[[SCRIPT-purge]]", clause: "5.3" },
    ]),
    diff: diffPolicy(V1, V2_WITHOUT_53),
  });

  it("puts the worst verdict first", () => {
    expect(map.rows.map((row) => row.verdict)).toEqual([
      "clause-gone",
      "affected",
      "review",
      "clear",
    ]);
  });

  it("groups by what kind of thing depends on it", () => {
    expect(map.groups.map((group) => group.label)).toEqual([
      "Script",
      "Request gate",
      "Local SOP",
      "Form",
    ]);
  });

  it("counts the verdicts and states them in one line", () => {
    expect(map.counts).toEqual({ "clause-gone": 1, affected: 1, review: 1, clear: 1 });
    expect(map.headline).toBe(
      "4 dependants: 1 rests on a clause that has gone, 1 affected, 1 to review, 1 clear.",
    );
  });

  it("leaves out the clear rows when asked for what needs doing", () => {
    expect(actionable(map)).toHaveLength(3);
  });
});

describe("buildImpactMap — the vault's own gaps", () => {
  it("calls an empty map an absence of records, not an absence of impact", () => {
    const map = buildImpactMap({ policy: policy([]), diff: diffPolicy(V1, V2) });
    expect(map.rows).toEqual([]);
    expect(map.headline).toContain("absence of records");
  });

  it("names changed clauses nothing claims to rest on", () => {
    const map = buildImpactMap({
      policy: policy([{ what: "form", ref: "[[FORM-x]]", clause: "5.1" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(map.unclaimedClauses).toEqual(["5.2"]);
  });

  it("marks a ref that points at nothing in the vault, without conflating it with unchecked", () => {
    const unchecked = buildImpactMap({
      policy: policy([{ what: "form", ref: "[[FORM-gone]]", clause: "5.2" }]),
      diff: diffPolicy(V1, V2),
    });
    expect(unchecked.rows[0]?.resolved).toBeNull();

    const checked = buildImpactMap({
      policy: policy([{ what: "form", ref: "[[FORM-gone]]", clause: "5.2" }]),
      diff: diffPolicy(V1, V2),
      resolve: () => false,
    });
    expect(checked.rows[0]?.resolved).toBe(false);
  });
});

describe("collectEdges", () => {
  const incoming: PolicyEdge[] = [
    {
      kind: "policy",
      ref: "[[SOP extraction]]",
      label: "SOP extraction",
      clause: "5.2",
      note: "",
      declaredBy: "40 Policies/SOP extraction.md",
    },
  ];

  it("folds both ends of the dependency into one list", () => {
    const edges = collectEdges(policy([{ what: "gate", ref: "g", clause: "5.2" }]), incoming);
    expect(edges).toHaveLength(2);
  });

  it("collapses a dependency declared from both ends into one row", () => {
    const both = policy([
      { what: "policy", ref: "[[SOP extraction]]", clause: "5.2" },
    ]);
    expect(collectEdges(both, incoming)).toHaveLength(1);
  });
});
