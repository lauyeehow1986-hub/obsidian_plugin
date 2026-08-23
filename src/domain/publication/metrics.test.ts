import { describe, expect, it } from "vitest";
import { parsePublication, type PublicationNote } from "./publication";
import {
  countByStage,
  decisionTimes,
  impactReport,
  journalLandings,
  medianDecisionDays,
  resubmissions,
} from "./metrics";

const pub = (overrides: Record<string, unknown> = {}): PublicationNote =>
  parsePublication(`85 Publications/${String(overrides["id"] ?? "PUB-1")}.md`, {
    id: "PUB-1",
    title: "A paper",
    stage: "under-review",
    journal: "European Heart Journal",
    ...overrides,
  });

describe("count by stage", () => {
  it("lists every stage, including the empty ones", () => {
    // "Nothing in revision" is a fact about the pipeline; dropping the bar
    // changes the shape of the chart (§6).
    const { counts, total } = countByStage([pub({ stage: "drafting" }), pub({ stage: "drafting" })]);
    expect(counts).toHaveLength(10);
    expect(counts.find((count) => count.stage === "drafting")?.count).toBe(2);
    expect(counts.find((count) => count.stage === "revision")?.count).toBe(0);
    expect(total).toBe(2);
  });

  it("counts a stage it does not recognise separately rather than folding it in", () => {
    const { unrecognised, counts } = countByStage([pub({ stage: "in-limbo" })]);
    expect(unrecognised).toEqual([{ stage: "in-limbo", count: 1 }]);
    expect(counts.reduce((sum, count) => sum + count.count, 0)).toBe(0);
  });
});

describe("time to first decision", () => {
  const submittedThenAnswered = pub({
    history: [
      { at: "2026-01-01", to: "submitted" },
      { at: "2026-03-02", to: "revision" },
      { at: "2026-05-01", to: "submitted" },
      { at: "2026-05-10", to: "accepted" },
    ],
  });

  it("pairs the first submission with the first answer", () => {
    // Pairing later ones would measure our revision speed, not the journal's.
    const [time] = decisionTimes([submittedThenAnswered]);
    expect(time?.days).toBe(60);
    expect(time?.decision).toBe("revision");
  });

  it("ignores a manuscript still waiting rather than scoring it zero", () => {
    // A zero would read as "answered instantly" and drag the median down.
    const waiting = pub({ history: [{ at: "2026-01-01", to: "submitted" }] });
    expect(decisionTimes([waiting])).toEqual([]);
  });

  it("ignores a manuscript that was never submitted", () => {
    expect(decisionTimes([pub({ history: [{ at: "2026-01-01", to: "drafting" }] })])).toEqual([]);
  });

  it("reports the median with the count behind it and who it could not see", () => {
    const waiting = pub({ id: "PUB-2", history: [{ at: "2026-06-01", to: "submitted" }] });
    const summary = medianDecisionDays([submittedThenAnswered, waiting]);
    expect(summary).toEqual({ days: 60, measured: 1, awaiting: 1 });
  });

  it("has no median when nothing has been answered", () => {
    expect(medianDecisionDays([pub()]).days).toBeNull();
  });
});

describe("resubmissions", () => {
  it("counts submissions after the first, and remembers where it went", () => {
    // The same argument as the request bounce count (§5.1): a paper on its
    // third journal looks fresh if you only read the current stage.
    const [entry] = resubmissions([
      pub({
        journal: "Circulation",
        history: [
          { at: "2026-01-01", to: "submitted", journal: "European Heart Journal" },
          { at: "2026-03-01", to: "rejected" },
          { at: "2026-04-01", to: "submitted", journal: "Circulation" },
        ],
      }),
    ]);
    expect(entry?.count).toBe(1);
    expect(entry?.journeys).toEqual(["European Heart Journal", "Circulation"]);
  });

  it("leaves out a paper accepted where it was sent", () => {
    expect(
      resubmissions([
        pub({
          history: [
            { at: "2026-01-01", to: "submitted" },
            { at: "2026-03-01", to: "accepted" },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

describe("where the department lands", () => {
  it("counts acceptances and rejections side by side", () => {
    // "We send here a lot and it never takes us" is the actionable half.
    const journals = journalLandings([
      pub({ id: "a", stage: "published", journal: "EHJ", scdb_supported: true }),
      pub({ id: "b", stage: "in-press", journal: "EHJ" }),
      pub({ id: "c", stage: "rejected", journal: "Lancet" }),
    ]);
    expect(journals[0]).toEqual({ journal: "EHJ", landed: 2, rejected: 0, scdbSupported: 1 });
    expect(journals[1]).toEqual({ journal: "Lancet", landed: 0, rejected: 1, scdbSupported: 0 });
  });

  it("blames the journal that rejected, not the one the paper moved to", () => {
    const journals = journalLandings([
      pub({
        stage: "published",
        journal: "Circulation",
        history: [
          { at: "2026-01-01", to: "submitted", journal: "Lancet" },
          { at: "2026-02-01", to: "rejected" },
          { at: "2026-03-01", to: "submitted", journal: "Circulation" },
          { at: "2026-06-01", to: "published" },
        ],
      }),
    ]);
    expect(journals.find((entry) => entry.journal === "Lancet")?.rejected).toBe(1);
    expect(journals.find((entry) => entry.journal === "Circulation")?.landed).toBe(1);
  });

  it("does not invent a journal from a note that names none", () => {
    expect(journalLandings([pub({ stage: "published", journal: undefined })])).toEqual([]);
  });
});

describe("the impact report", () => {
  const vault = [
    pub({ id: "a", stage: "published", journal: "EHJ", scdb_supported: true, published: "2026-02-01" }),
    pub({ id: "b", stage: "published", journal: "EHJ", scdb_supported: false, published: "2025-02-01" }),
    pub({ id: "c", stage: "under-review", journal: "Lancet", scdb_supported: true }),
  ];

  it("counts the number that goes in front of a funding committee", () => {
    const report = impactReport(vault);
    expect(report.total).toBe(3);
    expect(report.scdbSupported).toBe(2);
    // Of the two the facility supported, only one is actually in print.
    expect(report.scdbPublished).toBe(1);
  });

  it("breaks output down by year, newest first, counting only what exists", () => {
    const report = impactReport(vault);
    expect(report.perYear).toEqual([
      { year: 2026, total: 1, scdbSupported: 1 },
      { year: 2025, total: 1, scdbSupported: 0 },
    ]);
  });

  it("survives an empty vault without claiming anything", () => {
    const report = impactReport([]);
    expect(report.total).toBe(0);
    expect(report.decision.days).toBeNull();
    expect(report.journals).toEqual([]);
    expect(report.perYear).toEqual([]);
  });
});
