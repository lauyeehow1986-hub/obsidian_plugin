import { describe, expect, it } from "vitest";
import { parsePublication, type PublicationNote } from "./publication";
import {
  applyPublicationTransition,
  evaluatePublicationTransition,
  nextStages,
  PublicationRefused,
} from "./stages";

const NOW = Date.UTC(2026, 7, 24);

const pub = (overrides: Record<string, unknown> = {}): PublicationNote =>
  parsePublication("85 Publications/PUB-1.md", {
    id: "PUB-2026-007",
    title: "A paper",
    stage: "under-review",
    journal: "European Heart Journal",
    submitted: "2026-04-02",
    ...overrides,
  });

describe("what a manuscript may do next", () => {
  it("offers only declared moves", () => {
    expect(nextStages("in-press")).toEqual(["published"]);
    expect(nextStages("published")).toEqual([]);
  });

  it("has no next stage for a stage that is not one of ours", () => {
    expect(nextStages("in-limbo")).toEqual([]);
  });

  it("lets a rejected paper go back out, because that is what papers do", () => {
    // §5.4 counts resubmissions. Closing this door would make that always zero.
    expect(nextStages("rejected")).toContain("submitted");
    expect(nextStages("rejected")).toContain("revision");
  });

  it("lets a shelved paper be picked up again", () => {
    expect(nextStages("shelved")).toContain("drafting");
  });
});

describe("refusals", () => {
  it("refuses a stage the vocabulary does not have", () => {
    const decision = evaluatePublicationTransition({ publication: pub(), to: "in-limbo" });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]?.kind).toBe("unknown-target");
  });

  it("refuses a move the manuscript cannot make, and says what it can", () => {
    const decision = evaluatePublicationTransition({ publication: pub({ stage: "drafting" }), to: "accepted" });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]?.kind).toBe("not-declared");
    expect(decision.refusals[0]?.message).toContain("Internal review");
  });

  it("refuses standing still", () => {
    const decision = evaluatePublicationTransition({ publication: pub(), to: "under-review" });
    expect(decision.refusals[0]?.kind).toBe("same-stage");
  });

  it("refuses to move a published paper anywhere", () => {
    const decision = evaluatePublicationTransition({ publication: pub({ stage: "published" }), to: "revision" });
    expect(decision.refusals[0]?.kind).toBe("terminal");
  });

  it("refuses a note whose own stage it cannot read", () => {
    const decision = evaluatePublicationTransition({ publication: pub({ stage: "" }), to: "accepted" });
    expect(decision.refusals[0]?.kind).toBe("unknown-stage");
  });

  it("throws rather than writing anything, with no override path", () => {
    // Unlike a request gate (§5.6) there is nothing here worth overriding: a
    // refusal means the note and the vocabulary disagree.
    expect(() =>
      applyPublicationTransition({
        publication: pub({ stage: "published" }),
        to: "revision",
        now: NOW,
        actor: "yh",
      }),
    ).toThrow(PublicationRefused);
  });
});

describe("warnings, which do not block", () => {
  it("says when a submission has no journal to land at", () => {
    const decision = evaluatePublicationTransition({
      publication: pub({ stage: "drafting", journal: undefined }),
      to: "submitted",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.warnings[0]).toContain("where the department lands");
  });

  it("says when a decision date outlived the decision", () => {
    const decision = evaluatePublicationTransition({
      publication: pub({ decision_due: "2026-08-01" }),
      to: "accepted",
    });
    expect(decision.warnings[0]).toContain("decision_due");
  });
});

describe("the effects of a move", () => {
  it("sets the stage and appends one history entry, never rewriting others", () => {
    const effect = applyPublicationTransition({
      publication: pub(),
      to: "accepted",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["stage"]).toBe("accepted");
    expect(effect.patch.appendHistory).toEqual({ at: "2026-08-24", to: "accepted", by: "yh" });
  });

  it("logs a stage-change naming both ends", () => {
    const effect = applyPublicationTransition({
      publication: pub(),
      to: "accepted",
      now: NOW,
      actor: "yh",
    });
    expect(effect.audit).toHaveLength(1);
    expect(effect.audit[0]?.action).toBe("stage-change");
    expect(effect.audit[0]?.subject).toBe("PUB-2026-007");
    expect(effect.audit[0]?.detail).toBe("under-review→accepted");
  });

  it("records the new journal on the history entry when a paper moves house", () => {
    // `journal:` only ever holds the current one, so without this the second
    // submission erases where the first one went.
    const effect = applyPublicationTransition({
      publication: pub({ stage: "rejected" }),
      to: "submitted",
      journal: "Circulation",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["journal"]).toBe("Circulation");
    expect(effect.patch.appendHistory["journal"]).toBe("Circulation");
    expect(effect.audit[0]?.detail).toContain("Circulation");
  });

  it("does not overwrite the first submission date on a resubmission", () => {
    // Time to first decision measures from the first one; resetting it would
    // make every resubmitted paper look like it was answered quickly.
    const effect = applyPublicationTransition({
      publication: pub({ stage: "rejected", submitted: "2026-04-02" }),
      to: "submitted",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["submitted"]).toBeUndefined();
  });

  it("stamps the first submission date when there is not one yet", () => {
    const effect = applyPublicationTransition({
      publication: pub({ stage: "drafting", submitted: undefined }),
      to: "submitted",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["submitted"]).toBe("2026-08-24");
  });

  it("clears a decision date once the decision has arrived", () => {
    // Left in place it keeps surfacing in the briefing as an unanswered chase.
    const effect = applyPublicationTransition({
      publication: pub({ decision_due: "2026-08-01" }),
      to: "accepted",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.unset).toContain("decision_due");
  });

  it("keeps a decision date the caller supplies", () => {
    const effect = applyPublicationTransition({
      publication: pub({ stage: "submitted" }),
      to: "under-review",
      now: NOW,
      actor: "yh",
      decisionDue: Date.UTC(2026, 9, 1),
    });
    expect(effect.patch.set["decision_due"]).toBe("2026-10-01");
    expect(effect.patch.unset).toEqual([]);
  });

  it("stamps the publication date on the way into print", () => {
    const effect = applyPublicationTransition({
      publication: pub({ stage: "in-press" }),
      to: "published",
      now: NOW,
      actor: "yh",
    });
    expect(effect.patch.set["published"]).toBe("2026-08-24");
  });
});
