import { describe, expect, it } from "vitest";
import { diffPolicy } from "./diff";
import { buildImpactMap } from "./impact";
import { parsePolicy } from "./policy";
import {
  buildFrozenNote,
  impactReportPath,
  planRevision,
  renderImpactReport,
  revisionPath,
  revisionRecord,
  sanitiseVersion,
} from "./revision";

const AT = Date.parse("2026-08-24T10:00:00Z");
const FOLDER = "40 Policies";

const V1 = ["## 5.1 Internal use", "", "Permitted.", "", "## 5.2 Onward transfer", "", "A DUA is required."].join("\n");
const V2 = V1.replace("A DUA is required.", "A countersigned DUA is required.");

function policy(overrides: Record<string, unknown> = {}) {
  return parsePolicy("40 Policies/POL-A.md", {
    type: "policy",
    id: "POL-A",
    title: "Release",
    status: "current",
    version: "3",
    governs: [{ what: "gate", ref: "edata-request:extraction", clause: "5.2" }],
    ...overrides,
  });
}

describe("sanitiseVersion", () => {
  it("keeps a version that is already a safe name", () => {
    expect(sanitiseVersion("2026-A")).toBe("2026-A");
  });

  it("replaces the characters Windows will not take in a filename", () => {
    expect(sanitiseVersion("3/1")).toBe("3-1");
    expect(sanitiseVersion("v4: final")).toBe("v4- final");
  });

  it("has something to call an empty version", () => {
    expect(sanitiseVersion("  ")).toBe("unversioned");
  });
});

describe("revisionPath", () => {
  it("files a frozen copy under the policy id and the version", () => {
    expect(revisionPath(FOLDER, policy(), "3", AT)).toBe("40 Policies/_revisions/POL-A@3.md");
  });

  it("never overwrites a reissue under the same number", () => {
    // An issuer reissuing without renumbering is a real thing. The honest
    // record of it is two files (rule 8), not one overwritten one.
    const taken = (path: string) => path === "40 Policies/_revisions/POL-A@3.md";
    expect(revisionPath(FOLDER, policy(), "3", AT, taken)).toBe(
      "40 Policies/_revisions/POL-A@3 (2026-08-24).md",
    );
  });

  it("keeps going when the dated name is taken too", () => {
    const taken = (path: string) => !path.endsWith("-2).md");
    expect(revisionPath(FOLDER, policy(), "3", AT, taken)).toBe(
      "40 Policies/_revisions/POL-A@3 (2026-08-24-2).md",
    );
  });

  it("falls back to the filename when the note has no id", () => {
    const note = policy({ id: "" });
    expect(revisionPath(FOLDER, note, "3", AT)).toBe("40 Policies/_revisions/POL-A@3.md");
  });
});

describe("impactReportPath", () => {
  it("sits beside the frozen copy", () => {
    expect(impactReportPath("40 Policies/_revisions/POL-A@3.md")).toBe(
      "40 Policies/_revisions/POL-A@3 impact.md",
    );
  });
});

describe("planRevision", () => {
  const base = {
    policy: policy(),
    currentText: `---\ntype: policy\nversion: 3\n---\n\n${V1}`,
    incomingText: V2,
    newVersion: "4",
    policiesFolder: FOLDER,
    at: AT,
  };

  it("allows a real revision and says where the frozen copy goes", () => {
    const plan = planRevision(base);
    expect(plan.refusals).toEqual([]);
    expect(plan.frozenPath).toBe("40 Policies/_revisions/POL-A@3.md");
    expect(plan.frozenVersion).toBe("3");
  });

  it("does not treat the current note's frontmatter as a change", () => {
    expect(planRevision(base).diff.addedLines).toBe(1);
  });

  it("refuses when the policy has no version to file the copy under", () => {
    const plan = planRevision({ ...base, policy: policy({ version: "" }) });
    expect(plan.refusals.join(" ")).toContain("no `version`");
    expect(plan.frozenPath).toBe("");
  });

  it("refuses when the incoming document declares no version", () => {
    expect(planRevision({ ...base, newVersion: "  " }).refusals.join(" ")).toContain(
      "Give the version",
    );
  });

  it("refuses a revision that changes nothing", () => {
    const plan = planRevision({ ...base, incomingText: V1 });
    expect(plan.refusals.join(" ")).toContain("nothing to freeze");
  });

  it("warns rather than refuses when an issuer reissues under the same number", () => {
    const plan = planRevision({ ...base, newVersion: "3" });
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("reissues without renumbering");
  });

  it("refuses a re-export that differs only in line endings", () => {
    const plan = planRevision({ ...base, incomingText: `${V1.replace(/\n/g, "\r\n")}\r\n` });
    expect(plan.refusals.join(" ")).toContain("nothing to freeze");
  });

  it("warns when the change is whitespace only", () => {
    const respaced = V1.split("\n")
      .map((line) => (line.trim() === "" ? "" : `  ${line} `))
      .join("\n\n");
    const plan = planRevision({ ...base, incomingText: respaced });
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("whitespace");
  });

  it("warns when nothing that changed carries a clause number", () => {
    // Otherwise every dependant comes back clear and the map looks reassuring
    // for the wrong reason.
    const plan = planRevision({
      ...base,
      currentText: "## Definitions\n\nWords.",
      incomingText: "## Definitions\n\nOther words.",
    });
    expect(plan.warnings.join(" ")).toContain("come back clear");
  });
});

describe("buildFrozenNote", () => {
  const frozen = buildFrozenNote({
    policy: policy(),
    currentText: `---\ntype: policy\nversion: 3\n---\n\n${V1}`,
    version: "3",
    at: AT,
    actor: "yh",
    summary: "Countersignature added at 5.2.",
    frontmatterYaml: "type: policy\nversion: 3",
  });

  it("carries a type of its own, so the register never lists it as a policy", () => {
    expect(frozen.startsWith("---\ntype: policy-revision\n")).toBe(true);
  });

  it("says on its face that it must not be edited", () => {
    expect(frozen).toContain("Frozen copy — never edited.");
  });

  it("keeps the body verbatim", () => {
    expect(frozen).toContain("A DUA is required.");
  });

  it("keeps the old frontmatter where nothing will machine-read it", () => {
    // Rule 8: nothing the user wrote is lost. Merging it into the snapshot's
    // own frontmatter would produce a note that looks live.
    expect(frozen).toContain("## Frontmatter as it stood");
    expect(frozen).toContain("```yaml\ntype: policy\nversion: 3\n```");
  });

  it("quotes a summary that would otherwise break the YAML", () => {
    const quoted = buildFrozenNote({
      policy: policy(),
      currentText: V1,
      version: "3",
      at: AT,
      actor: "yh",
      summary: "5.2: countersignature",
      frontmatterYaml: "",
    });
    expect(quoted).toContain('summary: "5.2: countersignature"');
  });
});

describe("revisionRecord", () => {
  it("records what the live note needs to find the copy again", () => {
    expect(
      revisionRecord({
        version: "3",
        frozen: "40 Policies/_revisions/POL-A@3.md",
        at: AT,
        actor: "yh",
        summary: "Countersignature added.",
      }),
    ).toEqual({
      version: "3",
      frozen: "40 Policies/_revisions/POL-A@3.md",
      on: "2026-08-24",
      by: "yh",
      summary: "Countersignature added.",
    });
  });
});

describe("renderImpactReport", () => {
  const diff = diffPolicy(V1, V2);
  const report = renderImpactReport({
    map: buildImpactMap({
      policy: policy({
        governs: [
          { what: "gate", ref: "edata-request:extraction", clause: "5.2" },
          { what: "policy", ref: "[[SOP extraction]]" },
        ],
      }),
      diff,
    }),
    diff,
    fromVersion: "3",
    toVersion: "4",
    frozenPath: "40 Policies/_revisions/POL-A@3.md",
    at: AT,
    actor: "yh",
  });

  it("links back to the text it was computed against", () => {
    expect(report).toContain("[[40 Policies/_revisions/POL-A@3]]");
  });

  it("tabulates what changed, by clause", () => {
    expect(report).toContain("| 5.2 Onward transfer | changed | 1 | 1 |");
  });

  it("explains what a Review row means, where somebody will read it", () => {
    expect(report).toContain("They are not judged unaffected");
  });

  it("states the limit of what it can know", () => {
    expect(report).toContain("an undeclared dependency cannot");
  });

  it("is a note the vault can index", () => {
    expect(report.startsWith("---\ntype: policy-impact\n")).toBe(true);
  });
});
