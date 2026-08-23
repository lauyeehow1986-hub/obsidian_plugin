import { describe, expect, it } from "vitest";
import { RAW_SPEC, testSpec } from "./testFixtures";
import {
  allowedTargets,
  isBackwardMove,
  isKnownStage,
  isTransitionDeclared,
  humaniseStageId,
  parseWorkflowSpec,
  resolveStage,
  stageLabelOf,
} from "./workflow";

function errors(raw: unknown): string[] {
  return parseWorkflowSpec(raw)
    .problems.filter((p) => p.severity === "error")
    .map((p) => `${p.at}: ${p.message}`);
}

describe("parseWorkflowSpec", () => {
  it("reads the placeholder eData spec", () => {
    const { spec, problems } = parseWorkflowSpec(RAW_SPEC);
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(spec?.id).toBe("edata-request");
    expect(spec?.version).toBe(1);
    expect(spec?.stages).toHaveLength(9);
    expect(spec?.stages[0]).toMatchObject({ id: "intake", label: "Intake", slaDays: 2, order: 0 });
    expect(spec?.stages.find((s) => s.id === "delivered")?.terminal).toBe(true);
    expect(spec?.gates).toHaveLength(3);
  });

  it("defaults a stage label to its id and an absent sla to no target", () => {
    const { spec } = parseWorkflowSpec({
      id: "w",
      version: 1,
      stages: [{ id: "only" }],
    });
    expect(spec?.stages[0]).toMatchObject({ id: "only", label: "only", slaDays: null, owner: "" });
  });

  it("refuses a spec with no id, no version or no stages", () => {
    expect(errors({})).toEqual(
      expect.arrayContaining([
        expect.stringContaining("id:"),
        expect.stringContaining("version:"),
        expect.stringContaining("stages:"),
      ]),
    );
    expect(parseWorkflowSpec({}).spec).toBeNull();
    expect(parseWorkflowSpec(null).spec).toBeNull();
    expect(parseWorkflowSpec("not yaml").spec).toBeNull();
    expect(errors({ ...RAW_SPEC, version: 0 })).toEqual([expect.stringContaining("version")]);
    expect(errors({ ...RAW_SPEC, version: 1.5 })).toEqual([expect.stringContaining("version")]);
  });

  it("refuses duplicate stage ids", () => {
    expect(
      errors({ id: "w", version: 1, stages: [{ id: "a" }, { id: "a" }] }),
    ).toEqual([expect.stringContaining("Duplicate stage id")]);
  });

  it("refuses transitions and gates naming unknown stages", () => {
    expect(
      errors({ ...RAW_SPEC, transitions: [{ from: ["intake"], to: ["nowhere"] }] }),
    ).toEqual([expect.stringContaining('Unknown stage "nowhere"')]);
    expect(
      errors({ ...RAW_SPEC, gates: [{ to: "nowhere", require: ["x"] }] }),
    ).toEqual([expect.stringContaining('unknown stage "nowhere"')]);
  });

  it("refuses a gate that requires nothing", () => {
    // A governance control that silently passes is worse than none at all.
    expect(errors({ ...RAW_SPEC, gates: [{ to: "approved", message: "hm" }] })).toEqual([
      expect.stringContaining("requires nothing"),
    ]);
  });

  it("validates the retired mapping so historical stages still resolve", () => {
    const { spec } = parseWorkflowSpec({ ...RAW_SPEC, retired: { "pre-triage": "triage" } });
    expect(spec?.retired).toEqual({ "pre-triage": "triage" });

    expect(errors({ ...RAW_SPEC, retired: { old: "nowhere" } })).toEqual([
      expect.stringContaining("unknown stage"),
    ]);
    expect(errors({ ...RAW_SPEC, retired: { triage: "qc" } })).toEqual([
      expect.stringContaining("both a live stage and a retired one"),
    ]);
  });

  it("warns rather than fails on things that are merely suspicious", () => {
    const noTransitions = parseWorkflowSpec({ ...RAW_SPEC, transitions: [] });
    expect(noTransitions.spec).not.toBeNull();
    expect(noTransitions.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "warning", at: "transitions" }),
      ]),
    );

    const terminalWithExits = parseWorkflowSpec({
      ...RAW_SPEC,
      transitions: [{ from: ["delivered"], to: ["qc"] }],
    });
    expect(terminalWithExits.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("terminal"),
        }),
      ]),
    );
  });
});

describe("stage resolution", () => {
  const spec = testSpec({ retired: { "pre-triage": "triage" } });

  it("resolves live and retired stages", () => {
    expect(resolveStage(spec, "triage")?.id).toBe("triage");
    expect(resolveStage(spec, "pre-triage")?.id).toBe("triage");
    expect(resolveStage(spec, "nonsense")).toBeNull();
    expect(isKnownStage(spec, "pre-triage")).toBe(true);
    expect(isKnownStage(spec, "nonsense")).toBe(false);
  });
});

describe("transitions", () => {
  const spec = testSpec();

  it("follows the declared graph", () => {
    expect(isTransitionDeclared(spec, "triage", "awaiting-approval")).toBe(true);
    expect(isTransitionDeclared(spec, "triage", "delivered")).toBe(false);
    expect(isTransitionDeclared(spec, "qc", "extraction")).toBe(true);
  });

  it("treats a stage with no rule as unconstrained", () => {
    // `delivered` and `withdrawn` have no outgoing rule; the terminal flag, not
    // the transition list, is what stops them (checked in transition.test.ts).
    expect(isTransitionDeclared(spec, "withdrawn", "triage")).toBe(true);
  });

  it("offers only reachable targets, and none from a terminal stage", () => {
    expect(allowedTargets(spec, "triage").map((s) => s.id)).toEqual([
      "awaiting-approval",
      "on-hold",
      "withdrawn",
    ]);
    expect(allowedTargets(spec, "delivered")).toEqual([]);
  });

  it("detects a move back down the stage order", () => {
    expect(isBackwardMove(spec, "qc", "extraction")).toBe(true);
    expect(isBackwardMove(spec, "extraction", "qc")).toBe(false);
    expect(isBackwardMove(spec, "triage", "nonsense")).toBe(false);
  });
});

describe("stageLabelOf", () => {
  const spec = testSpec({ retired: { "pending-approval": "awaiting-approval" } });

  it("prints the declared label for a live stage", () => {
    expect(stageLabelOf(spec, "awaiting-approval")).toBe("Awaiting approval");
    expect(stageLabelOf(spec, "qc")).toBe("QC");
  });

  it("humanises a retired stage instead of resolving it", () => {
    // Both halves matter. "Pending approval" is readable, and it is NOT
    // "Awaiting approval": resolving through `retired:` would put two different
    // stages under one name and hide that REQ-2026-007 needs migrating (§5.2).
    expect(stageLabelOf(spec, "pending-approval")).toBe("Pending approval");
    expect(stageLabelOf(spec, "pending-approval")).not.toBe(
      stageLabelOf(spec, "awaiting-approval"),
    );
  });

  it("humanises a stage dropped without any mapping", () => {
    expect(stageLabelOf(spec, "scoping")).toBe("Scoping");
  });

  it("humanises with no spec at all", () => {
    // A vault with no workflow file still renders boards; it must not render
    // slugs in the one place a spec would have supplied prose.
    expect(stageLabelOf(null, "pending-approval")).toBe("Pending approval");
  });
});

describe("humaniseStageId", () => {
  it("is sentence case, matching the declared labels", () => {
    expect(humaniseStageId("pending-approval")).toBe("Pending approval");
    expect(humaniseStageId("awaiting_second_review")).toBe("Awaiting second review");
    expect(humaniseStageId("triage")).toBe("Triage");
  });

  it("collapses runs of separators rather than emitting double spaces", () => {
    expect(humaniseStageId("on--hold")).toBe("On hold");
    expect(humaniseStageId("  spaced  out  ")).toBe("Spaced out");
  });

  it("returns an id that humanises to nothing untouched", () => {
    // A blank cell reads as "no data"; an ugly one reads as "look at this".
    expect(humaniseStageId("")).toBe("");
    expect(humaniseStageId("---")).toBe("---");
  });
});
