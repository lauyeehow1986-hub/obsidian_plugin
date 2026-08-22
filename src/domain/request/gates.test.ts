import { describe, expect, it } from "vitest";
import { buildGateContext, evaluateAtom, evaluateGatesFor } from "./gates";
import { parseRequest } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";

const spec = testSpec();

function req(overrides: Record<string, unknown> = {}) {
  return parseRequest(requestFrontmatter(overrides)).request;
}

function ctxFor(overrides: Record<string, unknown> = {}) {
  return buildGateContext(req(overrides), NOW);
}

function atom(text: string, overrides: Record<string, unknown> = {}) {
  return evaluateAtom(text, ctxFor(overrides));
}

describe("buildGateContext", () => {
  it("flattens frontmatter into dotted paths", () => {
    const ctx = ctxFor();
    expect(ctx.get("stage")?.value).toBe("awaiting-approval");
    expect(ctx.get("governance.identifiers")?.value).toBe("indirect");
    expect(ctx.get("governance.irb_ref")?.value).toBe("DSRB-2026-0142");
    expect(ctx.get("governance.dua.status")?.value).toBe("pending");
  });

  it("exposes list lengths and list emptiness", () => {
    expect(ctxFor().get("outputs.length")?.value).toBe(0);
    expect(ctxFor().get("outputs")?.value).toBe(false);
    const filled = ctxFor({ outputs: [{ kind: "table" }] });
    expect(filled.get("outputs.length")?.value).toBe(1);
    expect(filled.get("outputs")?.value).toBe(true);
  });

  it("derives _in_future and _in_past for any readable date", () => {
    const ctx = ctxFor();
    expect(ctx.get("governance.irb_expiry_in_future")?.value).toBe(true);
    expect(ctx.get("governance.irb_expiry_in_past")?.value).toBe(false);
    expect(ctx.get("received_in_past")?.value).toBe(true);
    expect(ctx.get("governance.irb_ref_in_future")).toBeUndefined();
  });

  it("does not descend into lists", () => {
    // A gate that depends on the position of a list entry is not maintainable.
    const ctx = ctxFor({ evidence: [{ for: "x", via: "email" }] });
    expect(ctx.get("evidence.0.via")).toBeUndefined();
    expect(ctx.get("evidence.length")?.value).toBe(1);
  });

  it("exposes evidence claims, distinguishing verbal from hard", () => {
    const hard = ctxFor({ evidence: [{ for: "dua_signed", via: "email" }] });
    expect(hard.get("evidence.dua_signed")?.value).toBe(true);
    expect(hard.get("evidence.dua_signed.any")?.value).toBe(true);

    const verbal = ctxFor({ evidence: [{ for: "dua_signed", via: "verbal" }] });
    expect(verbal.get("evidence.dua_signed")?.value).toBe(false);
    expect(verbal.get("evidence.dua_signed.any")?.value).toBe(true);
  });
});

describe("governance instruments", () => {
  it("does not accept a status of signed without an evidence record", () => {
    // §5.5: a governance gate must never rest on a bare boolean.
    const ctx = ctxFor({
      governance: { identifiers: "direct", dua: { status: "signed" } },
    });
    const entry = ctx.get("governance.dua_signed");
    expect(entry?.value).toBe(false);
    expect(entry?.note).toContain("no evidence record");
  });

  it("accepts a status of signed backed by non-verbal evidence", () => {
    const ctx = ctxFor({
      governance: { identifiers: "direct", dua: { status: "signed" } },
      evidence: [{ for: "dua_signed", via: "signed-document", by: "[[Dr A Tan]]" }],
    });
    expect(ctx.get("governance.dua_signed")?.value).toBe(true);
  });

  it("does not accept verbal evidence for a signature", () => {
    const ctx = ctxFor({
      governance: { identifiers: "direct", dua: { status: "signed" } },
      evidence: [{ for: "dua_signed", via: "verbal", by: "[[Dr A Tan]]" }],
    });
    expect(ctx.get("governance.dua_signed")?.value).toBe(false);
  });

  it("treats waived and not-required as satisfied but not as signed", () => {
    for (const status of ["waived", "not-required"]) {
      const ctx = ctxFor({ governance: { dua: { status } } });
      expect(ctx.get("governance.dua_satisfied")?.value).toBe(true);
      expect(ctx.get("governance.dua_signed")?.value).toBe(false);
    }
  });
});

describe("evaluateAtom", () => {
  it("treats a bare path as a presence check", () => {
    expect(atom("governance.irb_ref").ok).toBe(true);
    expect(atom("governance.pdpa_basis").ok).toBe(true);
    expect(atom("delivery_method").ok).toBe(false);
  });

  it("counts a numeric zero as present but an empty string as not", () => {
    expect(atom("sla_days", { sla_days: 0 }).ok).toBe(true);
    expect(atom("priority", { priority: "" }).ok).toBe(false);
  });

  it("compares against literals", () => {
    expect(atom("governance.identifiers == none").ok).toBe(false);
    expect(atom("governance.identifiers == indirect").ok).toBe(true);
    expect(atom('governance.identifiers == "indirect"').ok).toBe(true);
    expect(atom("governance.identifiers != none").ok).toBe(true);
    expect(atom("sla_days >= 21").ok).toBe(true);
    expect(atom("sla_days > 21").ok).toBe(false);
    expect(atom("outputs.length > 0").ok).toBe(false);
    expect(atom("outputs.length > 0", { outputs: [1] }).ok).toBe(true);
  });

  it("compares dates by instant, not by string", () => {
    expect(atom("governance.irb_expiry > 2026-12-31").ok).toBe(true);
    expect(atom("governance.irb_expiry < 2026-12-31").ok).toBe(false);
  });

  it("refuses to order two things that are neither numbers nor dates", () => {
    // A confident but meaningless answer is worse than a refusal.
    expect(atom("governance.identifiers > none").ok).toBe(false);
  });

  it("fails, never passes, on a path the request does not have", () => {
    const result = atom("governance.irb_refx");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not set");
    expect(atom("governance.typo == true").ok).toBe(false);
    expect(atom("governance.typo != true").ok).toBe(false);
  });

  it("fails an empty condition", () => {
    expect(atom("   ").ok).toBe(false);
  });

  it("explains itself in terms a person can act on", () => {
    expect(atom("governance.identifiers == none").reason).toBe(
      'governance.identifiers is "indirect", needs == "none"',
    );
    expect(atom("outputs.length > 0").reason).toBe("outputs.length is 0, needs > 0");
    expect(
      atom("governance.dua_signed == true", {
        governance: { dua: { status: "signed" } },
      }).reason,
    ).toContain("needs");
  });
});

describe("evaluateGatesFor", () => {
  it("passes the IRB gate when the reference is present and current", () => {
    const results = evaluateGatesFor(spec, req(), "approved", NOW);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.message).toBe("");
  });

  it("refuses approval on an expired IRB, and says which condition failed", () => {
    const results = evaluateGatesFor(
      spec,
      req({
        governance: { irb_ref: "DSRB-2026-0142", irb_expiry: "2026-03-31", identifiers: "indirect" },
      }),
      "approved",
      NOW,
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.message).toContain("Cannot approve without a current IRB/DSRB reference.");
    expect(results[0]!.message).toContain("governance.irb_expiry is 2026-03-31, which has passed");
  });

  it("refuses approval with no IRB reference at all", () => {
    const results = evaluateGatesFor(
      spec,
      req({ governance: { identifiers: "none" } }),
      "approved",
      NOW,
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.message).toContain("governance.irb_ref is not set");
  });

  it("lets a de-identified extraction through without a DUA", () => {
    const results = evaluateGatesFor(
      spec,
      req({ governance: { identifiers: "none" } }),
      "extraction",
      NOW,
    );
    expect(results[0]!.ok).toBe(true);
  });

  it("refuses an identifiable extraction with an unsigned DUA", () => {
    const results = evaluateGatesFor(spec, req(), "extraction", NOW);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.message).toContain("Identifiable extraction requires a signed DUA.");
    expect(results[0]!.message).toContain("needs one of:");
  });

  it("refuses an identifiable extraction whose DUA is claimed but not evidenced", () => {
    const results = evaluateGatesFor(
      spec,
      req({ governance: { identifiers: "indirect", dua: { status: "signed" } } }),
      "extraction",
      NOW,
    );
    expect(results[0]!.ok).toBe(false);
  });

  it("allows an identifiable extraction once the DUA is signed and evidenced", () => {
    const results = evaluateGatesFor(
      spec,
      req({
        governance: { identifiers: "indirect", dua: { status: "signed" } },
        evidence: [
          { for: "dua_signed", by: "[[Dr A Tan]]", on: "2026-07-22", via: "signed-document" },
        ],
      }),
      "extraction",
      NOW,
    );
    expect(results[0]!.ok).toBe(true);
  });

  it("requires every atom of a multi-condition gate", () => {
    const withOutputs = req({ outputs: [{ kind: "table" }] });
    expect(evaluateGatesFor(spec, withOutputs, "delivered", NOW)[0]!.ok).toBe(false);

    const complete = req({ outputs: [{ kind: "table" }], delivery_method: "secure-drive" });
    expect(evaluateGatesFor(spec, complete, "delivered", NOW)[0]!.ok).toBe(true);
  });

  it("returns nothing for an ungated stage", () => {
    expect(evaluateGatesFor(spec, req(), "triage", NOW)).toEqual([]);
  });

  it("reports every atom, passing and failing, so the check is inspectable", () => {
    const [result] = evaluateGatesFor(spec, req({ governance: {} }), "approved", NOW);
    expect(result!.atoms.map((a) => a.atom)).toEqual([
      "governance.irb_ref",
      "governance.irb_expiry_in_future",
    ]);
    expect(result!.atoms.every((a) => !a.ok)).toBe(true);
  });
});
