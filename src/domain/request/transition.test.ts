import { describe, expect, it } from "vitest";
import { verifyChain, chainEntry, CHAIN_GENESIS } from "../audit/ledger";
import { parseRequest } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";
import {
  TransitionRefused,
  applyTransition,
  evaluateTransition,
  type RefusalKind,
} from "./transition";

const spec = testSpec();

function req(overrides: Record<string, unknown> = {}) {
  return parseRequest(requestFrontmatter(overrides)).request;
}

function decide(to: string, overrides: Record<string, unknown> = {}) {
  return evaluateTransition({ spec, request: req(overrides), to, now: NOW });
}

function kinds(to: string, overrides: Record<string, unknown> = {}): RefusalKind[] {
  return decide(to, overrides).refusals.map((r) => r.kind);
}

describe("evaluateTransition — allowed", () => {
  it("allows a declared, ungated move", () => {
    const decision = decide("on-hold");
    expect(decision.allowed).toBe(true);
    expect(decision.refusals).toEqual([]);
    expect(decision.from).toBe("awaiting-approval");
  });

  it("allows a gated move when the gate is satisfied", () => {
    const decision = decide("approved");
    expect(decision.allowed).toBe(true);
    expect(decision.gates).toHaveLength(1);
    expect(decision.gates[0]!.ok).toBe(true);
  });
});

describe("evaluateTransition — structural refusals", () => {
  it("refuses a move the workflow does not declare", () => {
    expect(kinds("delivered")).toContain("not-declared");
    expect(decide("delivered").refusals[0]!.message).toContain(
      '"Awaiting approval" → "Delivered"',
    );
  });

  it("refuses a move to a stage that does not exist", () => {
    expect(kinds("teleported")).toContain("unknown-target");
  });

  it("refuses a move from a stage the spec does not have", () => {
    expect(kinds("triage", { stage: "pre-triage" })).toContain("unknown-stage");
  });

  it("refuses a move out of a terminal stage", () => {
    const refusals = kinds("extraction", {
      stage: "delivered",
      history: [{ at: "2026-07-20", to: "delivered" }],
    });
    expect(refusals).toContain("terminal");
  });

  it("refuses a move to the stage the request is already in", () => {
    expect(kinds("awaiting-approval")).toContain("same-stage");
  });

  it("refuses a request that follows a different workflow", () => {
    expect(kinds("on-hold", { workflow: "other-process" })).toContain("unknown-workflow");
  });

  it("quarantines a request left behind by a spec change", () => {
    // §5.2: renaming a stage strands in-flight requests, so they go through the
    // migration view rather than being nudged into a stage that may have
    // changed meaning.
    const behind = decide("on-hold", { workflow_version: 0 });
    expect(behind.refusals.map((r) => r.kind)).toContain("workflow-mismatch");
    expect(behind.refusals[0]!.message).toContain("Migrate it first");

    const frontmatter = requestFrontmatter();
    delete frontmatter["workflow_version"];
    const missing = evaluateTransition({
      spec,
      request: parseRequest(frontmatter).request,
      to: "on-hold",
      now: NOW,
    });
    expect(missing.refusals.map((r) => r.kind)).toContain("workflow-mismatch");
  });

  it("marks structural refusals as not overridable", () => {
    // This move fails structurally *and* on a gate; one non-overridable refusal
    // is enough to make the whole transition non-overridable.
    const decision = decide("delivered");
    expect(decision.overridable).toBe(false);
    expect(decision.refusals.find((r) => r.kind === "not-declared")?.overridable).toBe(false);
  });

  it("reports every problem at once rather than one at a time", () => {
    const decision = decide("extraction", { workflow_version: 0 });
    expect(decision.refusals.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["workflow-mismatch", "not-declared", "gate"]),
    );
  });
});

describe("evaluateTransition — gate refusals", () => {
  it("refuses an identifiable extraction without a signed DUA, with a reason", () => {
    const decision = evaluateTransition({
      spec,
      request: req({ stage: "approved", history: [{ at: "2026-07-20", to: "approved" }] }),
      to: "extraction",
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals.map((r) => r.kind)).toEqual(["gate"]);
    expect(decision.refusals[0]!.message).toContain("Identifiable extraction requires a signed DUA");
    expect(decision.overridable).toBe(true);
  });

  it("refuses approval on an expired IRB", () => {
    const decision = decide("approved", {
      governance: { irb_ref: "DSRB-2026-0142", irb_expiry: "2026-03-31", identifiers: "indirect" },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]!.gate?.gate.to).toBe("approved");
  });
});

describe("evaluateTransition — warnings", () => {
  it("warns about verbal-only evidence without blocking", () => {
    const decision = decide("on-hold", {
      evidence: [{ for: "dua_signed", via: "verbal", by: "[[Dr A Tan]]" }],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("verbal only")]),
    );
  });

  it("warns when the request has never been reconciled against the eData system", () => {
    // The vault is a working tracker, not the system of record (§5.1).
    expect(decide("on-hold").warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("never been reconciled")]),
    );
    expect(decide("on-hold", { last_reconciled: "2026-07-20" }).warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining("never been reconciled")]),
    );
  });
});

describe("applyTransition", () => {
  const command = { spec, now: NOW, actor: "yh" };

  it("produces a frontmatter patch and a history entry", () => {
    const effect = applyTransition({ ...command, request: req(), to: "approved" });
    expect(effect.patch.set).toEqual({ stage: "approved" });
    expect(effect.patch.appendHistory).toEqual({ at: "2026-07-28", to: "approved", by: "yh" });
    expect(effect.patch.unset).toEqual([]);
  });

  it("records a new holdup, and clears one on request", () => {
    const blocked = applyTransition({
      ...command,
      request: req(),
      to: "approved",
      blockedOn: "[[Coordinator B]]",
    });
    expect(blocked.patch.set).toMatchObject({
      blocked_on: "[[Coordinator B]]",
      blocked_since: "2026-07-28",
    });
    expect(blocked.patch.appendHistory["blocked_on"]).toBe("[[Coordinator B]]");

    const cleared = applyTransition({
      ...command,
      request: req(),
      to: "approved",
      blockedOn: null,
    });
    expect(cleared.patch.unset).toEqual(["blocked_on", "blocked_since"]);
    expect(cleared.patch.set["blocked_on"]).toBeUndefined();
  });

  it("leaves the holdup alone when the caller says nothing about it", () => {
    const effect = applyTransition({ ...command, request: req(), to: "approved" });
    expect(effect.patch.unset).toEqual([]);
    expect(effect.patch.set["blocked_on"]).toBeUndefined();
  });

  it("logs a stage-change entry for every move", () => {
    const effect = applyTransition({ ...command, request: req(), to: "approved" });
    expect(effect.audit).toEqual([
      {
        ts: "2026-07-28T12:00",
        actor: "yh",
        action: "stage-change",
        subject: "REQ-2026-014",
        detail: "awaiting-approval→approved",
      },
    ]);
  });

  it("falls back to the uid when a request has no human label", () => {
    const effect = applyTransition({ ...command, request: req({ id: "" }), to: "approved" });
    expect(effect.audit[0]!.subject).toBe("01JZQ8MW5T3K7XBN2FHVCD9RGA");
  });

  it("refuses a structurally impossible move outright", () => {
    expect(() => applyTransition({ ...command, request: req(), to: "delivered" })).toThrow(
      TransitionRefused,
    );
    expect(() =>
      applyTransition({
        ...command,
        request: req(),
        to: "delivered",
        override: { reason: "the director said so" },
      }),
    ).toThrow(TransitionRefused);
  });
});

describe("gate overrides", () => {
  const blockedByGate = {
    spec,
    now: NOW,
    actor: "yh",
    request: req({ stage: "approved", history: [{ at: "2026-07-20", to: "approved" }] }),
    to: "extraction",
  };

  it("refuses an override with no typed reason", () => {
    // §5.6: refusing to give a reason cancels the override. This is the single
    // rule that carries most of the audit value.
    expect(() => applyTransition(blockedByGate)).toThrow(/typed reason/i);
    expect(() => applyTransition({ ...blockedByGate, override: { reason: "  " } })).toThrow(
      /typed reason/i,
    );
  });

  it("carries the reason into the ledger alongside the stage change", () => {
    const effect = applyTransition({
      ...blockedByGate,
      override: { reason: "DUA countersigned in the meeting, scan to follow" },
    });
    expect(effect.audit.map((e) => e.action)).toEqual(["stage-change", "gate-override"]);
    expect(effect.audit[1]!.detail).toContain(
      "reason: DUA countersigned in the meeting, scan to follow",
    );
    expect(effect.audit[1]!.detail).toContain("Identifiable extraction requires a signed DUA");
    expect(effect.patch.set["stage"]).toBe("extraction");
  });

  it("logs one override row per refused gate", () => {
    const twoGates = testSpec({
      gates: [
        { to: "extraction", require: ["governance.dua_signed"], message: "DUA needed." },
        { to: "extraction", require: ["delivery_method"], message: "Delivery method needed." },
      ],
    });
    const effect = applyTransition({
      ...blockedByGate,
      spec: twoGates,
      override: { reason: "approved out of band" },
    });
    expect(effect.audit.filter((e) => e.action === "gate-override")).toHaveLength(2);
  });

  it("produces entries that chain and verify", () => {
    const effect = applyTransition({
      ...blockedByGate,
      override: { reason: "extension granted verbally, letter pending" },
    });
    let previous = CHAIN_GENESIS;
    const rows = effect.audit.map((entry) => {
      const row = chainEntry(previous, entry);
      previous = row.chain;
      return row;
    });
    expect(verifyChain(rows).ok).toBe(true);
  });
});
