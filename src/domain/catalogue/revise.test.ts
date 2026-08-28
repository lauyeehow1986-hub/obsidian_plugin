import { describe, expect, it } from "vitest";
import { diffDefinition, historyRecord, planRevision } from "./revise";
import { currentDefinition, parseVariable } from "./variable";

const AT = Date.parse("2026-08-29T09:00:00Z");

function lvef(over: Record<string, unknown> = {}) {
  return parseVariable("87 Catalogue/VAR-LVEF.md", {
    type: "variable",
    id: "VAR-LVEF",
    label: "Left ventricular ejection fraction",
    data_type: "numeric",
    units: "%",
    valid_range: [0, 100],
    definition: "Biplane Simpson's.",
    version: 2,
    supersedes: "VAR-LVEF@1",
    changed: "2023-07-01",
    change_reason: "Moved off visual estimation.",
    identifier: false,
    history: [{ version: 1, on: "2019-04-01", definition: "Visual estimate.", reason: "First issue." }],
    ...over,
  });
}

describe("diffDefinition", () => {
  it("reports only the fields the change actually moves", () => {
    const changes = diffDefinition(currentDefinition(lvef()), {
      definition: "Biplane Simpson's, per ESC 2025.",
      units: "%",
    });
    expect(changes.map((change) => change.field)).toEqual(["definition"]);
    expect(changes[0]).toMatchObject({ before: "Biplane Simpson's.", after: "Biplane Simpson's, per ESC 2025." });
  });

  it("compares a range by value, not by identity", () => {
    expect(diffDefinition(currentDefinition(lvef()), { validRange: [0, 100] })).toEqual([]);
    expect(diffDefinition(currentDefinition(lvef()), { validRange: [10, 90] })).toHaveLength(1);
  });

  it("compares coding entry by entry", () => {
    const before = currentDefinition(lvef({ data_type: "categorical", coding: "1, Mild | 2, Severe", valid_range: undefined }));
    expect(diffDefinition(before, { coding: [{ code: "1", label: "Mild" }, { code: "2", label: "Severe" }] })).toEqual([]);
    expect(diffDefinition(before, { coding: [{ code: "1", label: "Mild" }] })).toHaveLength(1);
  });

  it("renders the identifier flag as yes and no, not true and false", () => {
    const changes = diffDefinition(currentDefinition(lvef()), { identifier: true });
    expect(changes[0]).toMatchObject({ label: "Identifier", before: "no", after: "yes" });
  });
});

describe("historyRecord", () => {
  it("writes the whole governed state, not only what changed", () => {
    // A sparse entry would make resolving a past version depend on folding
    // several together; a self-contained one can be read on its own.
    expect(historyRecord(lvef(), AT)).toEqual({
      version: 2,
      on: "2023-07-01",
      definition: "Biplane Simpson's.",
      reason: "Moved off visual estimation.",
      data_type: "numeric",
      units: "%",
      valid_range: [0, 100],
      identifier: false,
    });
  });

  it("leaves the date out rather than stamping today's when the note never said", () => {
    const record = historyRecord(lvef({ changed: undefined }), AT);
    expect("on" in record).toBe(false);
  });

  it("leaves an empty reason out rather than writing a blank one", () => {
    // Version 1 replaced nothing, so it has no reason to record. `reason: ""`
    // would read as a reason somebody failed to give.
    const record = historyRecord(lvef({ version: 1, change_reason: undefined, changed: "2019-04-01" }), AT);
    expect("reason" in record).toBe(false);
  });
});

describe("planRevision", () => {
  const change = { definition: "Biplane Simpson's, per ESC 2025." };

  it("bumps the version, names what it supersedes, and dates it", () => {
    const plan = planRevision({ variable: lvef(), changes: change, reason: "Aligned to ESC 2025.", at: AT });
    expect(plan.refusals).toEqual([]);
    expect({ from: plan.fromVersion, to: plan.toVersion, supersedes: plan.supersedes }).toEqual({
      from: 2,
      to: 3,
      supersedes: "VAR-LVEF@2",
    });
    expect(plan.patch).toMatchObject({
      version: 3,
      supersedes: "VAR-LVEF@2",
      changed: "2026-08-29",
      change_reason: "Aligned to ESC 2025.",
      definition: "Biplane Simpson's, per ESC 2025.",
    });
  });

  it("refuses a revision with no typed reason", () => {
    const plan = planRevision({ variable: lvef(), changes: change, reason: "   ", at: AT });
    expect(plan.refusals.join(" ")).toContain("Say in one line why");
  });

  it("refuses a version bump that changes nothing", () => {
    const plan = planRevision({ variable: lvef(), changes: { units: "%" }, reason: "tidy", at: AT });
    expect(plan.refusals.join(" ")).toContain("Nothing in the definition changed");
  });

  it("refuses when there is no id to name the superseded version after", () => {
    const plan = planRevision({ variable: lvef({ id: undefined }), changes: change, reason: "r", at: AT });
    expect(plan.refusals.join(" ")).toContain("no `id`");
  });

  it("refuses when the version is not a whole number to bump", () => {
    const plan = planRevision({ variable: lvef({ version: "two" }), changes: change, reason: "r", at: AT });
    expect(plan.refusals.join(" ")).toContain("no readable whole-number `version`");
  });

  it("carries only field names and counts into the ledger detail (rule 7)", () => {
    const plan = planRevision({ variable: lvef(), changes: change, reason: "Aligned to ESC 2025.", at: AT });
    expect(plan.auditDetail).toBe("v2→v3; definition changed");
    expect(plan.auditDetail).not.toContain("Simpson");
  });

  it("marks a revision that moves the identifier flag, so it can be logged as identifier-scope", () => {
    const plan = planRevision({ variable: lvef(), changes: { identifier: true }, reason: "r", at: AT });
    expect(plan.identifierMoved).toBe(true);
    expect(planRevision({ variable: lvef(), changes: change, reason: "r", at: AT }).identifierMoved).toBe(false);
  });

  it("preserves the prior definition in the record it hands to the writer", () => {
    const plan = planRevision({ variable: lvef(), changes: change, reason: "r", at: AT });
    expect(plan.record).toMatchObject({ version: 2, definition: "Biplane Simpson's.", on: "2023-07-01" });
  });
});
