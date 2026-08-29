import { describe, expect, it } from "vitest";
import {
  checkUrl,
  isSourceId,
  MAX_RESULTS,
  MIN_INTERVAL_MS,
  previewRequest,
  SOURCES,
  SOURCE_IDS,
} from "./gateway";

describe("the allowlist", () => {
  it("accepts each source's own host", () => {
    expect(checkUrl("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed")).toEqual(
      { ok: true, source: "pubmed" },
    );
    expect(checkUrl("https://clinicaltrials.gov/api/v2/studies?format=json")).toEqual({
      ok: true,
      source: "ctgov",
    });
  });

  it("matches the host exactly, never by suffix", () => {
    // The classic ways an allowlist stops being one.
    for (const host of [
      "notclinicaltrials.gov",
      "clinicaltrials.gov.evil.example",
      "evil-clinicaltrials.gov",
      "eutils.ncbi.nlm.nih.gov.evil.example",
    ]) {
      const decision = checkUrl(`https://${host}/api/v2/studies`);
      expect(decision.ok, host).toBe(false);
      if (!decision.ok) expect(decision.why).toContain(host);
    }
  });

  it("is not fooled by credentials in the authority", () => {
    // Parses with hostname evil.example despite reading like the real host.
    const decision = checkUrl("https://eutils.ncbi.nlm.nih.gov@evil.example/x");
    expect(decision.ok).toBe(false);
  });

  it("refuses credentials even on an allowlisted host", () => {
    const decision = checkUrl("https://user:pass@clinicaltrials.gov/api/v2/studies");
    expect(decision).toEqual({
      ok: false,
      why: "That URL carries a username or password, which is never expected.",
    });
  });

  it("refuses a port, so a redirect cannot reach an internal service", () => {
    const decision = checkUrl("https://clinicaltrials.gov:8080/api/v2/studies");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.why).toContain("port");
  });

  it("refuses anything that is not https", () => {
    for (const url of [
      "http://clinicaltrials.gov/api/v2/studies",
      "file:///C:/Windows/win.ini",
      "ftp://clinicaltrials.gov/x",
      "javascript:alert(1)",
      "data:text/html,hi",
    ]) {
      expect(checkUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses a string that is not a URL at all", () => {
    expect(checkUrl("clinicaltrials.gov/api").ok).toBe(false);
    expect(checkUrl("").ok).toBe(false);
  });

  it("is case-insensitive about the host, as DNS is", () => {
    expect(checkUrl("https://CLINICALTRIALS.GOV/api/v2/studies").ok).toBe(true);
  });
});

describe("the request preview", () => {
  it("carries the literal URL, not a description of it", () => {
    const url = "https://clinicaltrials.gov/api/v2/studies?query.cond=heart+failure";
    const preview = previewRequest(url, "the words you typed");
    expect(preview).toEqual({
      source: "ctgov",
      label: "ClinicalTrials.gov",
      operator: "US National Library of Medicine",
      host: "clinicaltrials.gov",
      url,
      carries: "the words you typed",
    });
  });

  it("refuses rather than previewing a URL the gate would reject", () => {
    const preview = previewRequest("https://evil.example/x", "anything");
    expect(preview).toHaveProperty("why");
    expect(preview).not.toHaveProperty("url");
  });
});

describe("the source registry", () => {
  it("gives every source exactly one host and one rate limit", () => {
    for (const id of SOURCE_IDS) {
      expect(SOURCES[id].host).toMatch(/^[a-z0-9.-]+$/);
      expect(MIN_INTERVAL_MS[id]).toBeGreaterThan(0);
    }
  });

  it("keeps NCBI's three-a-second policy with room to spare", () => {
    // Being blocked would present as "the feature is broken" on a machine with
    // no way to diagnose it, so the interval is checked rather than assumed.
    expect(MIN_INTERVAL_MS.pubmed).toBeGreaterThanOrEqual(1000 / 3);
  });

  it("caps how much one action can pull down", () => {
    expect(MAX_RESULTS).toBeLessThanOrEqual(100);
  });

  it("recognises its own ids and nothing else", () => {
    expect(isSourceId("pubmed")).toBe(true);
    expect(isSourceId("guidelines")).toBe(false);
    expect(isSourceId(undefined)).toBe(false);
  });
});
