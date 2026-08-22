import { describe, expect, it } from "vitest";
import { evidenceFor, hasHardEvidence, parseRequest } from "./request";
import { requestFrontmatter } from "./testFixtures";

describe("parseRequest", () => {
  it("reads a well-formed request note", () => {
    const { request, problems } = parseRequest(requestFrontmatter());
    expect(problems).toEqual([]);
    expect(request.id).toBe("REQ-2026-014");
    expect(request.uid).toBe("01JZQ8MW5T3K7XBN2FHVCD9RGA");
    expect(request.externalRef).toBe("EDR-2026-00871");
    expect(request.stage).toBe("awaiting-approval");
    expect(request.blockedOn).toBe("[[Dr A Tan]]");
    expect(request.workflowVersion).toBe(1);
    expect(request.slaDays).toBe(21);
    expect(request.history).toHaveLength(3);
    expect(request.history[0]).toMatchObject({ to: "intake", by: "yh", blockedOn: null });
    expect(request.history[2]!.blockedOn).toBe("[[Dr A Tan]]");
  });

  it("keeps the raw frontmatter so gates can address unmodelled fields", () => {
    const { request } = parseRequest(requestFrontmatter({ delivery_method: "secure-drive" }));
    expect(request.raw["delivery_method"]).toBe("secure-drive");
  });

  it("reports rather than invents when frontmatter is missing", () => {
    const { request, problems } = parseRequest(undefined);
    expect(request.stage).toBe("");
    expect(request.history).toEqual([]);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no frontmatter"),
        expect.stringContaining("no `stage`"),
        expect.stringContaining("no `uid`"),
      ]),
    );
  });

  it("drops unreadable history entries and says so", () => {
    const { request, problems } = parseRequest(
      requestFrontmatter({
        history: [
          { at: "2026-07-14", to: "intake" },
          { at: "not a date", to: "triage" },
          { at: "2026-07-18", to: "" },
          "just a string",
        ],
      }),
    );
    expect(request.history).toHaveLength(1);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("history[1]"),
        expect.stringContaining("history[2]"),
        expect.stringContaining("history[3]"),
      ]),
    );
  });

  it("sorts hand-edited history into date order and flags it", () => {
    const { request, problems } = parseRequest(
      requestFrontmatter({
        stage: "triage",
        history: [
          { at: "2026-07-16", to: "triage" },
          { at: "2026-07-14", to: "intake" },
        ],
      }),
    );
    expect(request.history.map((h) => h.to)).toEqual(["intake", "triage"]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("date order")]));
  });

  it("notices when `stage` disagrees with the last history entry", () => {
    const { problems } = parseRequest(requestFrontmatter({ stage: "extraction" }));
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining("does not match the last history entry")]),
    );
  });

  it("accepts Date objects, as a YAML parser produces them", () => {
    const { request } = parseRequest(
      requestFrontmatter({
        received: new Date("2026-07-14"),
        history: [{ at: new Date("2026-07-14"), to: "awaiting-approval" }],
      }),
    );
    expect(request.received).toBe(Date.UTC(2026, 6, 14));
    expect(request.history[0]!.at).toBe(Date.UTC(2026, 6, 14));
  });
});

describe("evidence records", () => {
  const withEvidence = (evidence: unknown[]) =>
    parseRequest(requestFrontmatter({ evidence })).request;

  it("reads a full record", () => {
    const request = withEvidence([
      {
        for: "irb_approval",
        by: "[[DSRB]]",
        on: "2026-03-04",
        via: "portal",
        ref: "DSRB-2026-0142",
        artefact: "[[DSRB-2026-0142 approval.pdf]]",
      },
    ]);
    expect(request.evidence[0]).toMatchObject({
      claim: "irb_approval",
      by: "[[DSRB]]",
      on: Date.UTC(2026, 2, 4),
      via: "portal",
      ref: "DSRB-2026-0142",
      hard: true,
    });
  });

  it("treats verbal evidence as soft — it cannot satisfy a hard gate alone", () => {
    const request = withEvidence([{ for: "dua_signed", via: "verbal", by: "[[Dr A Tan]]" }]);
    expect(request.evidence[0]!.hard).toBe(false);
    expect(evidenceFor(request, "dua_signed")).toHaveLength(1);
    expect(hasHardEvidence(request, "dua_signed")).toBe(false);
  });

  it("treats an unrecognised `via` as soft and reports it", () => {
    const { request, problems } = parseRequest(
      requestFrontmatter({ evidence: [{ for: "dua_signed", via: "carrier pigeon" }] }),
    );
    expect(request.evidence[0]!.hard).toBe(false);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("unrecognised")]));
  });

  it("ignores records that evidence nothing", () => {
    const { request, problems } = parseRequest(
      requestFrontmatter({ evidence: [{ by: "[[Dr A Tan]]", via: "email" }] }),
    );
    expect(request.evidence).toEqual([]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining("no `for`")]));
  });

  it("matches claims case-insensitively", () => {
    const request = withEvidence([{ for: "DUA_Signed", via: "email" }]);
    expect(hasHardEvidence(request, "dua_signed")).toBe(true);
  });
});
