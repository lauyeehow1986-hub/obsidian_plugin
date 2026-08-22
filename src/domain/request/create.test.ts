import { describe, expect, it } from "vitest";
import { isUlid } from "../id/ulid";
import { DEFAULT_ID_PREFIX, newRequest, newRequestBody, nextRequestId } from "./create";
import { parseRequest } from "./request";
import { NOW, testSpec } from "./testFixtures";
import { evaluateTransition } from "./transition";

const spec = testSpec();

describe("nextRequestId", () => {
  it("starts at 001 in an empty vault", () => {
    expect(nextRequestId([], 2026)).toBe("REQ-2026-001");
    expect(DEFAULT_ID_PREFIX).toBe("REQ");
  });

  it("continues from the highest existing number for that year", () => {
    expect(nextRequestId(["REQ-2026-001", "REQ-2026-013", "REQ-2026-007"], 2026)).toBe(
      "REQ-2026-014",
    );
  });

  it("ignores other years, other prefixes and anything unparseable", () => {
    expect(
      nextRequestId(["REQ-2025-098", "PUB-2026-004", "REQ-2026-abc", "notes", ""], 2026),
    ).toBe("REQ-2026-001");
  });

  it("does not renumber past a three-digit year", () => {
    expect(nextRequestId(["REQ-2026-999"], 2026)).toBe("REQ-2026-1000");
  });

  it("supports an owner segment for when a second person allocates ids", () => {
    expect(nextRequestId(["REQ-2026-YH-003"], 2026, { owner: "YH" })).toBe("REQ-2026-YH-004");
    // Someone else's ids do not advance yours.
    expect(nextRequestId(["REQ-2026-AB-050"], 2026, { owner: "YH" })).toBe("REQ-2026-YH-001");
  });
});

describe("newRequest", () => {
  const base = {
    spec,
    now: NOW,
    actor: "yh",
    id: "REQ-2026-014",
    title: "  Readmission cohort for the HF service  ",
  };

  it("writes a note that parses back cleanly", () => {
    const created = newRequest(base);
    const { request, problems } = parseRequest(created.frontmatter);
    expect(problems).toEqual([]);
    expect(request.id).toBe("REQ-2026-014");
    expect(request.title).toBe("Readmission cohort for the HF service");
    expect(request.stage).toBe("intake");
    expect(request.workflow).toBe("edata-request");
    expect(request.workflowVersion).toBe(1);
    expect(isUlid(request.uid)).toBe(true);
    expect(created.filename).toBe("REQ-2026-014.md");
  });

  it("can immediately be moved on, with no migration in the way", () => {
    // A note created by the plugin must never land in the quarantine its own
    // version check enforces.
    const { request } = parseRequest(newRequest(base).frontmatter);
    expect(evaluateTransition({ spec, request, to: "triage", now: NOW }).allowed).toBe(true);
  });

  it("opens the history with the first stage", () => {
    const created = newRequest(base);
    expect(created.frontmatter["history"]).toEqual([
      { at: "2026-07-28", to: "intake", by: "yh" },
    ]);
  });

  it("omits fields the caller did not supply", () => {
    const created = newRequest(base);
    for (const key of ["study", "requester", "due", "sla_days", "assignee", "external_ref"]) {
      expect(created.frontmatter).not.toHaveProperty(key);
    }
  });

  it("writes the fields the caller did supply", () => {
    const created = newRequest({
      ...base,
      requester: "[[Dr A Tan]]",
      study: "[[EuroHeart]]",
      hat: "hod",
      due: Date.UTC(2026, 7, 4),
      slaDays: 21,
      externalRef: "EDR-2026-00871",
      identifiers: "indirect",
    });
    expect(created.frontmatter).toMatchObject({
      requester: "[[Dr A Tan]]",
      study: "[[EuroHeart]]",
      due: "2026-08-04",
      sla_days: 21,
      external_ref: "EDR-2026-00871",
      governance: { identifiers: "indirect" },
    });
  });

  it("defaults the identifier scope to none, explicitly", () => {
    // Absent is not the same as "we decided there are no identifiers", and the
    // gates need to be able to tell.
    expect(newRequest(base).frontmatter["governance"]).toEqual({ identifiers: "none" });
  });

  it("takes an injected uid so tests and imports are deterministic", () => {
    const created = newRequest({ ...base, uid: "01JZQ8MW5T3K7XBN2FHVCD9RGA" });
    expect(created.frontmatter["uid"]).toBe("01JZQ8MW5T3K7XBN2FHVCD9RGA");
  });

  it("logs both the arrival and the identifier scope", () => {
    const created = newRequest({ ...base, identifiers: "direct" });
    expect(created.audit.map((e) => e.action)).toEqual(["stage-change", "identifier-scope"]);
    expect(created.audit[0]!.detail).toBe("(new)→intake");
    expect(created.audit[1]!.detail).toBe("identifiers: direct");
    expect(created.audit.every((e) => e.subject === "REQ-2026-014")).toBe(true);
  });

  it("starts the body with headings, not with data", () => {
    expect(newRequestBody(base)).toContain("# Readmission cohort for the HF service");
  });
});
