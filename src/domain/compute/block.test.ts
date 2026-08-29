import { describe, expect, it } from "vitest";
import {
  describeBlock,
  findRunnableBlocks,
  locateBlock,
  previewLine,
  runLanguage,
} from "./block";

const NOTE = [
  "# Working note",
  "",
  "Some prose about the cohort.",
  "",
  "```python",
  "import statistics",
  "print(statistics.mean([1, 2, 3]))",
  "```",
  "",
  "More prose.",
  "",
  "```r",
  "mean(c(1, 2, 3))",
  "```",
  "",
  "```sql",
  "select 1",
  "```",
  "",
  "```py",
  "print('second python')",
  "```",
  "",
].join("\n");

describe("what counts as runnable", () => {
  it("finds R and Python blocks and ignores everything else", () => {
    const blocks = findRunnableBlocks(NOTE);
    expect(blocks.map((block) => block.language)).toEqual(["python", "r", "python"]);
  });

  it("numbers blocks per language, not overall", () => {
    const blocks = findRunnableBlocks(NOTE);
    expect(blocks.map((block) => block.ordinal)).toEqual([1, 1, 2]);
    expect(blocks.map((block) => block.index)).toEqual([1, 2, 3]);
  });

  it("accepts the spellings people actually write", () => {
    expect(runLanguage("py")).toBe("python");
    expect(runLanguage("Python3")).toBe("python");
    expect(runLanguage("R")).toBe("r");
    expect(runLanguage("Rscript")).toBe("r");
    expect(runLanguage("javascript")).toBeNull();
  });

  it("reports the line the block starts on", () => {
    const blocks = findRunnableBlocks(NOTE);
    expect(blocks[0]?.line).toBe(5);
    expect(blocks[1]?.line).toBe(12);
  });

  it("keeps the source verbatim", () => {
    const blocks = findRunnableBlocks(NOTE);
    expect(blocks[0]?.source).toBe("import statistics\nprint(statistics.mean([1, 2, 3]))\n");
  });

  // Opt-out, not opt-in: a block of R is R whether or not somebody remembered
  // a marker. `no-run` is for the block that must never be run — including the
  // archived copy of a past run in a provenance record.
  it("skips a block fenced no-run", () => {
    const text = ["```python no-run", "print('archived')", "```", ""].join("\n");
    expect(findRunnableBlocks(text)).toEqual([]);
  });

  it("does not see a fence nested inside a longer fence", () => {
    const text = ["````markdown", "```python", "print('example')", "```", "````", ""].join("\n");
    expect(findRunnableBlocks(text)).toEqual([]);
  });

  it("finds nothing in a note with no code", () => {
    expect(findRunnableBlocks("# Just prose\n\nNothing here.\n")).toEqual([]);
  });
});

describe("finding the block again after the note moved", () => {
  const blocks = findRunnableBlocks(NOTE);
  const first = blocks[0];
  if (first === undefined) throw new Error("fixture");

  it("matches on the source when the block has moved down the note", () => {
    const moved = `# Heading\n\nA new paragraph inserted above.\n\n${NOTE}`;
    const found = locateBlock(moved, first);
    expect(found?.source).toBe(first.source);
    expect(found?.line).toBeGreaterThan(first.line);
  });

  it("falls back to position when the block has been edited", () => {
    const edited = NOTE.replace("print(statistics.mean([1, 2, 3]))", "print('edited')");
    const found = locateBlock(edited, first);
    expect(found?.source).toContain("edited");
    expect(found?.ordinal).toBe(1);
  });

  it("picks the right one when two blocks are identical", () => {
    const twice = ["```python", "print(1)", "```", "", "```python", "print(1)", "```", ""].join("\n");
    const both = findRunnableBlocks(twice);
    const second = both[1];
    if (second === undefined) throw new Error("fixture");
    expect(locateBlock(twice, second)?.start).toBe(second.start);
  });

  // Running the wrong code is worse than running none, and this is the only
  // place that choice is made.
  it("returns null rather than guessing when the block is gone", () => {
    const gone = "# Heading\n\nAll the code was deleted.\n";
    expect(locateBlock(gone, first)).toBeNull();
  });

  it("does not cross languages", () => {
    const rOnly = ["```r", "mean(1:3)", "```", ""].join("\n");
    expect(locateBlock(rOnly, first)).toBeNull();
  });
});

describe("describing a block for a picker", () => {
  it("names the language, the position and the line", () => {
    const blocks = findRunnableBlocks(NOTE);
    const second = blocks[2];
    if (second === undefined) throw new Error("fixture");
    expect(describeBlock(second)).toBe("Python · block 2 · line 20");
  });

  it("skips comments, which are identical across blocks", () => {
    expect(previewLine("# ---- load ----\n\nlibrary(dplyr)\n")).toBe("library(dplyr)");
  });

  it("says so when there is nothing but comments", () => {
    expect(previewLine("# just a note\n")).toBe("(no code)");
  });

  it("truncates a long line rather than breaking the row", () => {
    const long = `x <- ${"a".repeat(200)}`;
    expect(previewLine(long).length).toBeLessThanOrEqual(72);
  });
});
