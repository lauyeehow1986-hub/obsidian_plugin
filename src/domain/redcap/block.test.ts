import { describe, expect, it } from "vitest";

import { findBlock, renderBlock, replaceBlock } from "./block";

const NOTE = [
  "# Baseline visit",
  "",
  "Prose a person wrote about why this instrument is shaped the way it is.",
  "",
  "```yaml redcap",
  "instruments:",
  "  - name: baseline",
  "```",
  "",
  "More prose, underneath, which also has to survive.",
  "",
].join("\n");

describe("the form block (§5.14, §7 D2)", () => {
  it("finds the tagged block", () => {
    const block = findBlock(NOTE);
    expect(block?.tagged).toBe(true);
    expect(block?.body).toBe("instruments:\n  - name: baseline\n");
  });

  it("prefers the tagged block over an earlier plain yaml fence", () => {
    const text = ["```yaml", "an: example", "```", "", "```yaml redcap", "instruments: []", "```"].join("\n");
    expect(findBlock(text)?.body).toBe("instruments: []\n");
  });

  it("falls back to a plain yaml fence, and the caller says it did", () => {
    const text = ["```yaml", "instruments: []", "```"].join("\n");
    expect(findBlock(text)?.tagged).toBe(false);
  });

  it("ignores a fence in another language", () => {
    expect(findBlock("```r\nlibrary(dplyr)\n```")).toBeNull();
  });

  /** Rule 8, and §5.1: the plugin never rewrites prose. */
  it("replaces only the block, leaving every word around it", () => {
    const after = replaceBlock(NOTE, "instruments:\n  - name: followup\n");
    expect(after).toContain("Prose a person wrote");
    expect(after).toContain("More prose, underneath");
    expect(after).toContain("- name: followup");
    expect(after).not.toContain("- name: baseline");
  });

  it("appends at the end when there is no block, not at the top", () => {
    const after = replaceBlock("# A form\n\nWhat it is for.\n", "instruments: []\n");
    expect(after.indexOf("What it is for.")).toBeLessThan(after.indexOf("```yaml redcap"));
  });

  it("survives a round trip through render and find", () => {
    const yaml = "instruments:\n  - name: baseline";
    expect(findBlock(renderBlock(yaml))?.body.trim()).toBe(yaml);
  });

  it("handles a longer fence, so a block containing a fence still closes correctly", () => {
    const text = ["````yaml redcap", "instruments: []", "```", "````"].join("\n");
    expect(findBlock(text)?.body).toBe("instruments: []\n```\n");
  });
});
