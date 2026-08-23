import { describe, expect, it } from "vitest";
import {
  ACTIVITIES,
  activityOrFallback,
  defaultActivityFor,
  defaultVocabularies,
  isKnownActivity,
  parseVocabularies,
} from "./vocabulary";

describe("the shipped vocabulary", () => {
  it("is §5.3's list, verbatim", () => {
    expect(ACTIVITIES).toEqual([
      "intake",
      "scoping",
      "governance-admin",
      "extraction",
      "qc",
      "analysis",
      "reporting",
      "meeting",
      "rework",
      "teaching",
      "other",
    ]);
  });

  it("keeps rework", () => {
    // It is the number that justifies process improvement to people who
    // otherwise hear only anecdotes (§5.3).
    expect(ACTIVITIES).toContain("rework");
  });

  it("gives each hat a starting activity", () => {
    expect(defaultActivityFor("biostat")).toBe("analysis");
    expect(defaultActivityFor("hod")).toBe("extraction");
    expect(defaultActivityFor("research-core")).toBe("governance-admin");
    expect(isKnownActivity(defaultVocabularies(), defaultActivityFor("anything-else"))).toBe(true);
  });
});

describe("parseVocabularies", () => {
  it("takes the file's activity list when there is one", () => {
    const { vocab, problems } = parseVocabularies({
      activities: ["triage", "extract", "triage"],
      cost_centres: ["RC-01"],
    });
    expect(vocab.activities).toEqual(["triage", "extract"]);
    expect(vocab.costCentres).toEqual(["RC-01"]);
    expect(vocab.fromFile).toBe(true);
    expect(problems).toEqual([]);
  });

  it("uses the built-in list when there is no file", () => {
    const { vocab } = parseVocabularies(null);
    expect(vocab.activities).toEqual([...ACTIVITIES]);
    expect(vocab.fromFile).toBe(false);
  });

  it("falls back to the built-in list rather than to no vocabulary", () => {
    // An empty list would refuse every activity and stop the timer writing
    // anything: a typo in a config file would cost a day of entries.
    for (const bad of [{ activities: [] }, { activities: "extraction" }, ["a", "b"]]) {
      const { vocab, problems } = parseVocabularies(bad);
      expect(vocab.activities).toEqual([...ACTIVITIES]);
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it("accepts the American spelling of the cost-centre key too", () => {
    expect(parseVocabularies({ cost_centers: ["RC-02"] }).vocab.costCentres).toEqual(["RC-02"]);
  });

  it("says what it could not read", () => {
    const { problems } = parseVocabularies({ activities: ["a"], cost_centres: 7 });
    expect(problems[0]).toContain("cost_centres");
  });
});

describe("activityOrFallback", () => {
  it("keeps a known activity", () => {
    expect(activityOrFallback(defaultVocabularies(), "qc")).toBe("qc");
  });

  it("falls back to the first of a custom vocabulary that has no `other`", () => {
    // Offering a value the log would then flag is a dead end.
    const { vocab } = parseVocabularies({ activities: ["triage", "extract"] });
    expect(activityOrFallback(vocab, "qc")).toBe("triage");
  });

  it("falls back to `other` when the vocabulary has it", () => {
    expect(activityOrFallback(defaultVocabularies(), "not-a-thing")).toBe("other");
  });
});
