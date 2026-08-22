import { describe, expect, it } from "vitest";
import { captureStem, freeFilename, newCapture } from "./capture";

const NOW = Date.parse("2026-08-23T09:12:00");

describe("captureStem", () => {
  it("puts the date and time first so the inbox sorts chronologically", () => {
    expect(captureStem("Ask Dr Tan about the DUA", NOW)).toBe(
      "2026-08-23 0912 Ask Dr Tan about the DUA",
    );
  });

  it("strips characters Windows or Obsidian will not accept in a filename", () => {
    const stem = captureStem('REQ/2026: "the ?cohort" [draft] #2 <urgent>', NOW);
    expect(stem).not.toMatch(/[\\/:*?"<>|#^[\]]/);
    expect(stem).toContain("REQ 2026");
  });

  it("caps the length, because a capture that fails to save is the one failure this cannot have", () => {
    const stem = captureStem("word ".repeat(80), NOW);
    expect(stem.length).toBeLessThanOrEqual(80);
  });

  it("never ends in a dot, which Windows refuses", () => {
    expect(captureStem("Check the SOP...", NOW).endsWith(".")).toBe(false);
  });

  it("falls back to the timestamp when the text leaves nothing usable", () => {
    expect(captureStem("///", NOW)).toBe("2026-08-23 0912");
  });
});

describe("freeFilename", () => {
  it("uses the plain name when it is free", () => {
    expect(freeFilename("a note", new Set())).toBe("a note.md");
  });

  it("suffixes rather than overwriting", () => {
    // Rule 8: never destroy data you did not write — including data you wrote
    // forty seconds ago.
    const taken = new Set(["a note.md", "a note 2.md"]);
    expect(freeFilename("a note", taken)).toBe("a note 3.md");
  });
});

describe("newCapture", () => {
  const capture = newCapture({ text: "  Chase the DUA  ", now: NOW, mode: "hod", uid: "UID" });

  it("records the hat, because it is free now and gone by triage time", () => {
    expect(capture.frontmatter["mode"]).toBe("hod");
    expect(capture.frontmatter["type"]).toBe("capture");
    expect(capture.frontmatter["captured"]).toBe("2026-08-23T09:12");
  });

  it("marks it untriaged explicitly rather than by an absent key", () => {
    expect(capture.frontmatter["triaged"]).toBe(false);
  });

  it("keeps the text verbatim and parses nothing out of it", () => {
    // Guessing a request id at capture time would put a wrong link in a note
    // the user never opened. B6 does extraction, deterministically and later.
    expect(newCapture({ text: "re REQ-2026-014 by Friday", now: NOW, mode: "hod" }).body).toBe(
      "re REQ-2026-014 by Friday\n",
    );
    expect(capture.body).toBe("Chase the DUA\n");
  });

  it("asks no second question — there is no field to leave blank", () => {
    expect(Object.keys(capture.frontmatter).sort()).toEqual([
      "captured",
      "mode",
      "triaged",
      "type",
      "uid",
    ]);
  });

  it("refuses an empty capture rather than writing an empty note", () => {
    expect(() => newCapture({ text: "   ", now: NOW, mode: "hod" })).toThrow(/nothing to capture/i);
  });
});
