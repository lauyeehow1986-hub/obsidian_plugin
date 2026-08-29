import { describe, expect, it } from "vitest";
import {
  ctgovSearchUrl,
  humanPhase,
  humanStatus,
  isNctId,
  parseCtgovSearch,
  TRIAL_STATUSES,
} from "./ctgov";
import { checkUrl } from "./gateway";
import { CTGOV_BAD_REQUEST, CTGOV_SEARCH } from "./responses.fixture";

describe("building ClinicalTrials.gov URLs", () => {
  it("always passes the gate it will be checked by", () => {
    expect(checkUrl(ctgovSearchUrl({ condition: "heart failure" })).ok).toBe(true);
  });

  it("asks for named fields rather than whole study records", () => {
    // A full record runs to tens of kilobytes of eligibility prose this
    // feature never shows; the smallest defensible request is the honest one.
    const url = ctgovSearchUrl({ condition: "x" });
    expect(url).toContain("fields=NCTId");
    expect(url).toContain("countTotal=true");
  });

  it("keeps condition and free text apart", () => {
    // Probed live: a bare query.term of "heart failure readmission" returned
    // colorectal cancer and diabetes trials.
    const url = ctgovSearchUrl({ condition: "heart failure", term: "readmission" });
    expect(url).toContain("query.cond=heart%20failure");
    expect(url).toContain("query.term=readmission");
  });

  it("omits an empty filter rather than sending a blank one", () => {
    const url = ctgovSearchUrl({ condition: "x", term: "", status: "" });
    expect(url).not.toContain("query.term=");
    expect(url).not.toContain("filter.overallStatus");
  });

  it("encodes a query rather than letting it add parameters", () => {
    const url = ctgovSearchUrl({ condition: "a&pageSize=9999&fields=ALL" });
    expect(url.match(/pageSize=/g)).toHaveLength(1);
    expect(url.match(/fields=/g)).toHaveLength(1);
  });

  it("clamps the page size", () => {
    expect(ctgovSearchUrl({ condition: "x", pageSize: 9999 })).toContain("pageSize=50");
    expect(ctgovSearchUrl({ condition: "x", pageSize: -3 })).toContain("pageSize=1");
  });

  it("accepts every status it advertises", () => {
    for (const status of TRIAL_STATUSES) {
      expect(ctgovSearchUrl({ condition: "x", status })).toContain(
        `filter.overallStatus=${status}`,
      );
    }
  });

  it("knows a registry id from anything else", () => {
    expect(isNctId("NCT06345521")).toBe(true);
    expect(isNctId("nct06345521")).toBe(true);
    expect(isNctId("NCT123")).toBe(false);
    expect(isNctId("../etc/passwd")).toBe(false);
  });
});

describe("parsing a real search response", () => {
  it("reads the studies and the total", () => {
    const result = parseCtgovSearch(CTGOV_SEARCH);
    if ("why" in result) throw new Error("expected studies");
    expect(result.studies.length).toBe(3);
    expect(result.total).toBeGreaterThan(3);
    const first = result.studies[0];
    expect(first?.nctId).toMatch(/^NCT\d{8}$/);
    expect(first?.title.length).toBeGreaterThan(0);
    expect(first?.status.length).toBeGreaterThan(0);
  });

  it("de-duplicates the country list a multi-site trial repeats", () => {
    const result = parseCtgovSearch(CTGOV_SEARCH);
    if ("why" in result) throw new Error("expected studies");
    for (const study of result.studies) {
      expect(new Set(study.countries).size).toBe(study.countries.length);
    }
  });

  it("reports plain text as such rather than calling it malformed JSON", () => {
    // Captured from the live service: a bad parameter answers 400 with a
    // sentence, and that sentence is the actual answer to what went wrong.
    expect(CTGOV_BAD_REQUEST).toContain("Invalid value in parameter");
    const result = parseCtgovSearch(CTGOV_BAD_REQUEST);
    expect(result).toHaveProperty("why");
  });

  it("survives modules that are missing entirely", () => {
    const sparse = JSON.stringify({
      studies: [{ protocolSection: { identificationModule: { nctId: "NCT00000001" } } }],
      totalCount: 1,
    });
    const result = parseCtgovSearch(sparse);
    if ("why" in result) throw new Error("expected studies");
    expect(result.studies[0]).toMatchObject({
      nctId: "NCT00000001",
      title: "",
      phases: [],
      countries: [],
      enrolment: "",
    });
  });

  it("drops a study with no identifier rather than emitting a blank row", () => {
    const result = parseCtgovSearch(JSON.stringify({ studies: [{}, {}], totalCount: 2 }));
    if ("why" in result) throw new Error("expected studies");
    expect(result.studies).toEqual([]);
  });
});

describe("making the API's spelling readable (§6)", () => {
  it("turns upper snake case into a sentence", () => {
    expect(humanStatus("NOT_YET_RECRUITING")).toBe("Not yet recruiting");
    expect(humanStatus("COMPLETED")).toBe("Completed");
    expect(humanStatus("")).toBe("Unknown");
  });

  it("names phases and drops the ones that mean nothing to a reader", () => {
    expect(humanPhase(["PHASE2", "PHASE3"])).toBe("Phase 2/Phase 3");
    expect(humanPhase(["NA"])).toBe("");
    expect(humanPhase([])).toBe("");
  });
});
