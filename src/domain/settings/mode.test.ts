import { describe, expect, it } from "vitest";
import { allModes, matchesMode, modeInfo, nextMode, unhatted } from "./mode";
import { MODES, type Mode } from "./schema";

describe("the three hats", () => {
  it("describes every mode the schema declares", () => {
    // A mode with no entry would render as `undefined` in the status bar.
    for (const mode of MODES) {
      expect(modeInfo(mode).label.length).toBeGreaterThan(0);
      expect(modeInfo(mode).short.length).toBeGreaterThan(0);
      expect(modeInfo(mode).blurb.length).toBeGreaterThan(0);
    }
    expect(allModes()).toHaveLength(MODES.length);
  });

  it("gives every mode a distinct glyph, since §6 forbids colour alone", () => {
    const glyphs = allModes().map((info) => info.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("cycles through every mode and returns to the start", () => {
    let mode: Mode = MODES[0]!;
    const seen: Mode[] = [mode];
    for (let i = 1; i < MODES.length; i++) {
      mode = nextMode(mode);
      seen.push(mode);
    }
    expect(new Set(seen).size).toBe(MODES.length);
    expect(nextMode(mode)).toBe(MODES[0]);
  });
});

describe("matching a note to the hat being worn", () => {
  it("matches its own hat", () => {
    expect(matchesMode("hod", "hod")).toBe(true);
    expect(matchesMode("biostat", "hod")).toBe(false);
  });

  it("tolerates the casing and padding of hand-typed frontmatter", () => {
    expect(matchesMode("  HOD ", "hod")).toBe(true);
    expect(matchesMode("Research-Core", "research-core")).toBe(true);
  });

  it("shows an unhatted note under every mode rather than losing it", () => {
    // Deliberate: hiding unclassified work under all three hats would make the
    // filter a way to miss a request. The boards mark these instead.
    for (const mode of MODES) {
      expect(matchesMode("", mode)).toBe(true);
      expect(matchesMode(null, mode)).toBe(true);
      expect(matchesMode(undefined, mode)).toBe(true);
    }
    expect(unhatted(" ")).toBe(true);
    expect(unhatted("hod")).toBe(false);
  });

  it("hides a hat we do not recognise, so a typo is findable", () => {
    // Not the same as unhatted: `hat: hdo` is a claim about which hat, just a
    // wrong one. Folding it into whichever mode is on would bury the typo.
    for (const mode of MODES) expect(matchesMode("hdo", mode)).toBe(false);
  });
});
