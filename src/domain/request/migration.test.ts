import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { requestMetrics } from "./dwell";
import {
  applyMigration,
  describeMigration,
  isStranded,
  MigrationRefused,
  planMigration,
} from "./migration";
import { parseRequest, type RequestNote } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";

/** The spec as it stands today. Fixtures declare `workflow_version: 1`. */
const v1 = testSpec();

/** A later spec: `awaiting-approval` was renamed, `triage` survived. */
const v2 = testSpec({
  version: 2,
  stages: [
    { id: "intake", label: "Intake", owner: "scdb", sla_days: 2 },
    { id: "triage", label: "SCDB triage", owner: "scdb", sla_days: 3 },
    { id: "governance-review", label: "Governance review", owner: "approver", sla_days: 14 },
    { id: "approved", label: "Approved", owner: "scdb", sla_days: 1 },
    { id: "extraction", label: "Extraction", owner: "scdb", sla_days: 10 },
    { id: "qc", label: "QC", owner: "scdb", sla_days: 3 },
    { id: "delivered", label: "Delivered", owner: "scdb", terminal: true },
  ],
  transitions: [],
  gates: [],
  retired: { "awaiting-approval": "governance-review" },
});

function note(overrides: Record<string, unknown> = {}): RequestNote {
  return parseRequest(requestFrontmatter(overrides)).request;
}

describe("detecting stranded notes", () => {
  it("leaves a note alone when its version and stage both match the spec", () => {
    expect(isStranded(note(), v1)).toBe(false);
    expect(planMigration([note()], v1).items).toEqual([]);
  });

  it("strands a note whose version is behind, even when its stage still exists", () => {
    const request = note({ stage: "triage", history: [{ at: "2026-07-16", to: "triage" }] });
    expect(isStranded(request, v2)).toBe(true);

    const item = describeMigration(request, v2);
    expect(item.proposalSource).toBe("unchanged");
    expect(item.proposedStage).toBe("triage");
    expect(item.reasons).toEqual(["version-behind"]);
    expect(item.requiresReason).toBe(false);
    expect(item.explanation).toContain("v1");
    expect(item.explanation).toContain("v2");
  });

  it("strands a note whose stage exists only under `retired:`, and proposes the mapping", () => {
    const item = describeMigration(note(), v2);
    expect(item.proposalSource).toBe("retired-map");
    expect(item.proposedStage).toBe("governance-review");
    expect(item.reasons).toContain("stage-retired");
    expect(item.requiresReason).toBe(false);
    expect(item.explanation).toContain("was retired");
  });

  it("proposes nothing for a stage the spec has never heard of", () => {
    const request = note({
      stage: "scoping",
      history: [{ at: "2026-07-16", to: "scoping" }],
    });
    const item = describeMigration(request, v2);
    expect(item.proposalSource).toBe("none");
    expect(item.proposedStage).toBe("");
    expect(item.reasons).toContain("stage-unknown");
    // Never silently remap: with no proposal, the choice must be justified.
    expect(item.requiresReason).toBe(true);
  });

  it("treats a missing `workflow_version` as stranded, not as current", () => {
    const request = note({ workflow_version: undefined });
    expect(request.workflowVersion).toBeNull();
    expect(isStranded(request, v1)).toBe(true);
    expect(describeMigration(request, v1).reasons).toContain("version-missing");
  });

  it("lists a note written under a newer spec separately, and never rewrites it", () => {
    const request = note({ workflow_version: 9 });
    const plan = planMigration([request], v1);
    expect(plan.items).toEqual([]);
    expect(plan.ahead).toHaveLength(1);

    expect(() =>
      applyMigration({ spec: v1, request, toStage: "triage", actor: "yh", now: NOW }),
    ).toThrow(MigrationRefused);
  });

  it("puts the notes needing a decision at the top of the plan", () => {
    const unknown = note({ id: "REQ-2026-901", stage: "scoping", history: [] });
    const retired = note({ id: "REQ-2026-902" });
    const versionOnly = note({
      id: "REQ-2026-903",
      stage: "triage",
      history: [{ at: "2026-07-16", to: "triage" }],
    });

    const plan = planMigration([versionOnly, retired, unknown], v2);
    expect(plan.items.map((i) => i.proposalSource)).toEqual([
      "none",
      "retired-map",
      "unchanged",
    ]);
  });
});

describe("applying a migration", () => {
  it("bumps the version and writes no history when the stage did not change", () => {
    const request = note({ stage: "triage", history: [{ at: "2026-07-16", to: "triage" }] });
    const effect = applyMigration({
      spec: v2,
      request,
      toStage: "triage",
      actor: "yh",
      now: NOW,
    });

    expect(effect.remapped).toBe(false);
    expect(effect.patch.set).toEqual({ workflow_version: 2, stage: "triage" });
    // Nothing moved, so nothing belongs in `history`.
    expect(effect.patch.appendHistory).toBeUndefined();
    expect(effect.patch.unset).toEqual([]);
  });

  it("writes the mapping to history, marked so it never counts as a move", () => {
    const effect = applyMigration({
      spec: v2,
      request: note(),
      toStage: "governance-review",
      actor: "yh",
      now: NOW,
    });

    expect(effect.remapped).toBe(true);
    expect(effect.patch.set["stage"]).toBe("governance-review");
    expect(effect.patch.appendHistory).toMatchObject({
      to: "governance-review",
      by: "yh",
      migration: true,
      from: "awaiting-approval",
    });
  });

  it("logs a schema-migration entry naming both versions and the mapping", () => {
    const effect = applyMigration({
      spec: v2,
      request: note(),
      toStage: "governance-review",
      actor: "yh",
      now: NOW,
    });

    expect(effect.audit).toHaveLength(1);
    const entry = effect.audit[0]!;
    expect(entry.action).toBe("schema-migration");
    expect(entry.subject).toBe("REQ-2026-014");
    expect(entry.actor).toBe("yh");
    expect(entry.detail).toBe(
      "edata-request v1→v2; awaiting-approval→governance-review",
    );
  });

  it("says so in the ledger when the version bumped but the stage did not", () => {
    const request = note({ stage: "triage", history: [{ at: "2026-07-16", to: "triage" }] });
    const effect = applyMigration({
      spec: v2,
      request,
      toStage: "triage",
      actor: "yh",
      now: NOW,
    });
    expect(effect.audit[0]!.detail).toBe("edata-request v1→v2; stage unchanged");
  });

  it("records `unset` rather than a bogus version when the note had none", () => {
    const request = note({ workflow_version: undefined, stage: "triage", history: [] });
    const effect = applyMigration({
      spec: v2,
      request,
      toStage: "triage",
      actor: "yh",
      now: NOW,
    });
    expect(effect.audit[0]!.detail).toContain("vunset→v2");
  });

  it("fills in `workflow` only when the note leaves it out", () => {
    const named = applyMigration({
      spec: v2,
      request: note(),
      toStage: "governance-review",
      actor: "yh",
      now: NOW,
    });
    expect(named.patch.set["workflow"]).toBeUndefined();

    const unnamed = applyMigration({
      spec: v2,
      request: note({ workflow: undefined }),
      toStage: "governance-review",
      actor: "yh",
      now: NOW,
    });
    expect(unnamed.patch.set["workflow"]).toBe("edata-request");
  });
});

describe("refusing a migration", () => {
  it("refuses a target the spec did not propose unless a reason is typed", () => {
    const request = note();
    expect(() =>
      applyMigration({ spec: v2, request, toStage: "delivered", actor: "yh", now: NOW }),
    ).toThrow(/needs a typed reason/);

    const effect = applyMigration({
      spec: v2,
      request,
      toStage: "delivered",
      actor: "yh",
      now: NOW,
      reason: "delivered by hand before the rename; confirmed with the requester",
    });
    expect(effect.patch.set["stage"]).toBe("delivered");
    expect(effect.audit[0]!.detail).toContain(
      "reason: delivered by hand before the rename; confirmed with the requester",
    );
  });

  it("refuses a whitespace-only reason the same as no reason at all", () => {
    expect(() =>
      applyMigration({
        spec: v2,
        request: note(),
        toStage: "delivered",
        actor: "yh",
        now: NOW,
        reason: "   ",
      }),
    ).toThrow(MigrationRefused);
  });

  it("always needs a reason when the spec proposed nothing", () => {
    const request = note({ stage: "scoping", history: [{ at: "2026-07-16", to: "scoping" }] });
    expect(() =>
      applyMigration({ spec: v2, request, toStage: "triage", actor: "yh", now: NOW }),
    ).toThrow(/Nothing in the spec says/);
  });

  it("refuses to migrate a request into a retired stage id", () => {
    expect(() =>
      applyMigration({
        spec: v2,
        request: note(),
        toStage: "awaiting-approval",
        actor: "yh",
        now: NOW,
        reason: "any reason at all",
      }),
    ).toThrow(/cannot be migrated \*into\*/);
  });

  it("refuses a stage that is in no version of the spec", () => {
    expect(() =>
      applyMigration({
        spec: v2,
        request: note(),
        toStage: "invented",
        actor: "yh",
        now: NOW,
        reason: "any reason at all",
      }),
    ).toThrow(/There is no stage "invented"/);
  });

  it("refuses to migrate a note that follows a different workflow", () => {
    expect(() =>
      applyMigration({
        spec: v2,
        request: note({ workflow: "publication-review" }),
        toStage: "triage",
        actor: "yh",
        now: NOW,
        reason: "any reason at all",
      }),
    ).toThrow(/follows workflow "publication-review"/);
  });
});

describe("a migrated note keeps its dwell history", () => {
  /** Entered `awaiting-approval` 40 days ago; migrated to the new name today. */
  const migrated = note({
    stage: "governance-review",
    history: [
      { at: new Date(NOW - 44 * DAY_MS).toISOString(), to: "intake", by: "yh" },
      { at: new Date(NOW - 40 * DAY_MS).toISOString(), to: "awaiting-approval", by: "yh" },
      {
        at: new Date(NOW).toISOString(),
        to: "governance-review",
        by: "yh",
        migration: true,
        from: "awaiting-approval",
      },
    ],
    workflow_version: 2,
    received: new Date(NOW - 44 * DAY_MS).toISOString(),
  });

  it("does not reset the dwell clock", () => {
    const metrics = requestMetrics(migrated, v2, { now: NOW });
    // The request has been waiting 40 days. Renaming the stage changes nothing.
    expect(metrics.currentDwellMs).toBe(40 * DAY_MS);
    expect(metrics.stageSla.state).toBe("breached");
  });

  it("relabels the open occupancy instead of inventing a new one", () => {
    const metrics = requestMetrics(migrated, v2, { now: NOW });
    expect(metrics.segments.map((s) => s.stageId)).toEqual(["intake", "governance-review"]);
    expect(metrics.segments[1]!.ms).toBe(40 * DAY_MS);
    expect(metrics.segments[1]!.open).toBe(true);
  });

  it("does not count as a bounce or a revisit", () => {
    const metrics = requestMetrics(migrated, v2, { now: NOW });
    expect(metrics.bounceCount).toBe(0);
    expect(metrics.revisitCount).toBe(0);
  });

  it("does not report the note as stranded any more", () => {
    expect(isStranded(migrated, v2)).toBe(false);
    expect(requestMetrics(migrated, v2, { now: NOW }).problems).toEqual([]);
  });

  it("keeps a migration entry that has nothing before it as a real entry", () => {
    const first = note({
      stage: "triage",
      received: new Date(NOW - 3 * DAY_MS).toISOString(),
      history: [
        {
          at: new Date(NOW - 3 * DAY_MS).toISOString(),
          to: "triage",
          by: "yh",
          migration: true,
          from: "scoping",
        },
      ],
      workflow_version: 2,
    });
    const metrics = requestMetrics(first, v2, { now: NOW });
    expect(metrics.segments.map((s) => s.stageId)).toEqual(["triage"]);
    expect(metrics.currentDwellMs).toBe(3 * DAY_MS);
  });
});
