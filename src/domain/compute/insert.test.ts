import { describe, expect, it } from "vitest";
import { findRunnableBlocks } from "./block";
import {
  clearOutput,
  findOutputRegion,
  insertOutput,
  isFigureEmbed,
  renderOutputBlock,
  renderOutputBody,
} from "./insert";

const RUNS = "94 Runs";

function firstBlock(text: string) {
  const block = findRunnableBlocks(text)[0];
  if (block === undefined) throw new Error("fixture has no runnable block");
  return block;
}

const NOTE = ["# Note", "", "```python", "print(1)", "```", "", "Prose the person wrote.", ""].join("\n");

const RENDERED = renderOutputBlock({
  summary: "2026-08-29 16:40 · RUN-2026-08-29-0001 · Python 3.14.7 · 0.4 s · ok",
  stdout: "1",
  stderr: "",
  truncated: false,
  figures: [`${RUNS}/RUN-2026-08-29-0001-fig1.png`],
});

describe("what the output block says", () => {
  it("keeps the two streams apart rather than splicing them", () => {
    const body = renderOutputBody({ summary: "s", stdout: "out", stderr: "err", truncated: false });
    expect(body).toContain("out");
    expect(body).toContain("--- stderr ---");
    expect(body.indexOf("out")).toBeLessThan(body.indexOf("err"));
  });

  it("says so when a block printed nothing", () => {
    expect(renderOutputBody({ summary: "s", stdout: "", stderr: "", truncated: false })).toContain(
      "(no output)",
    );
  });

  it("says so when output was cut", () => {
    expect(renderOutputBody({ summary: "s", stdout: "x", stderr: "", truncated: true })).toContain(
      "cut in the middle",
    );
  });

  // Rule 11: a vault opened without this plugin has to read the same.
  it("is a plain text fence, not a custom syntax", () => {
    expect(RENDERED.startsWith("```text scdb-run\n")).toBe(true);
  });

  it("grows the fence when the output itself contains one", () => {
    const block = renderOutputBlock({
      summary: "s",
      stdout: "```\nnested\n```",
      stderr: "",
      truncated: false,
      figures: [],
    });
    expect(block.startsWith("````")).toBe(true);
  });

  it("embeds figures below the fence, where they render", () => {
    expect(RENDERED).toContain(`![[${RUNS}/RUN-2026-08-29-0001-fig1.png]]`);
  });
});

describe("finding the last run's output", () => {
  it("finds nothing under a block that has never been run", () => {
    expect(findOutputRegion(NOTE, firstBlock(NOTE), RUNS)).toBeNull();
  });

  it("finds the fence and its figures", () => {
    const { text } = insertOutput({ text: NOTE, block: firstBlock(NOTE), rendered: RENDERED, runsFolder: RUNS });
    const region = findOutputRegion(text, firstBlock(text), RUNS);
    expect(region?.figures).toEqual([`${RUNS}/RUN-2026-08-29-0001-fig1.png`]);
  });

  // The narrow definition is the whole of rule 8 here.
  it("does not claim a fence separated by a paragraph", () => {
    const text = NOTE.replace("```\n\nProse", "```\n\nProse first.\n\n```text scdb-run\nold\n```\n\nProse");
    expect(findOutputRegion(text, firstBlock(text), RUNS)).toBeNull();
  });

  it("does not claim somebody else's code block", () => {
    const text = ["```python", "print(1)", "```", "", "```r", "1 + 1", "```", ""].join("\n");
    expect(findOutputRegion(text, firstBlock(text), RUNS)).toBeNull();
  });

  it("stops at the first line that is not one of our embeds", () => {
    const text = [
      "```python",
      "print(1)",
      "```",
      "",
      "```text scdb-run",
      "ours",
      "```",
      `![[${RUNS}/RUN-2026-08-29-0001-fig1.png]]`,
      "![[a diagram the person embedded.png]]",
      "",
    ].join("\n");
    const region = findOutputRegion(text, firstBlock(text), RUNS);
    expect(region?.figures).toEqual([`${RUNS}/RUN-2026-08-29-0001-fig1.png`]);
    expect(text.slice(region?.end ?? 0)).toContain("a diagram the person embedded");
  });
});

describe("which embeds count as ours", () => {
  it("takes a figure in the runs folder named after a run", () => {
    expect(isFigureEmbed(`![[${RUNS}/RUN-2026-08-29-0001-fig1.png]]`, RUNS)).toBe(true);
  });

  it("ignores an embed of anything else", () => {
    expect(isFigureEmbed("![[a photo.png]]", RUNS)).toBe(false);
    expect(isFigureEmbed(`![[${RUNS}/notes.png]]`, RUNS)).toBe(false);
    expect(isFigureEmbed(`![[89 Diagrams/RUN-thing.png]]`, RUNS)).toBe(false);
  });

  it("ignores a line that is an embed plus anything else", () => {
    expect(isFigureEmbed(`See ![[${RUNS}/RUN-1-fig1.png]]`, RUNS)).toBe(false);
  });

  it("allows a display width, which Obsidian writes", () => {
    expect(isFigureEmbed(`![[${RUNS}/RUN-1-fig1.png|400]]`, RUNS)).toBe(true);
  });
});

describe("putting output into the note", () => {
  it("inserts under the block and leaves the prose alone", () => {
    const { text, replaced } = insertOutput({
      text: NOTE,
      block: firstBlock(NOTE),
      rendered: RENDERED,
      runsFolder: RUNS,
    });
    expect(replaced).toBeNull();
    expect(text).toContain("Prose the person wrote.");
    expect(text.indexOf("scdb-run")).toBeLessThan(text.indexOf("Prose the person wrote."));
  });

  // Six re-runs should not leave six transcripts. `94 Runs/` is the history.
  it("replaces the previous run rather than stacking", () => {
    const once = insertOutput({ text: NOTE, block: firstBlock(NOTE), rendered: RENDERED, runsFolder: RUNS }).text;
    const second = renderOutputBlock({
      summary: "second run",
      stdout: "2",
      stderr: "",
      truncated: false,
      figures: [],
    });
    const twice = insertOutput({
      text: once,
      block: firstBlock(once),
      rendered: second,
      runsFolder: RUNS,
    });
    expect(twice.replaced).not.toBeNull();
    expect(twice.text.match(/scdb-run/g)?.length).toBe(1);
    expect(twice.text).toContain("second run");
    expect(twice.text).not.toContain("RUN-2026-08-29-0001-fig1.png");
    expect(twice.text).toContain("Prose the person wrote.");
  });

  it("does not touch a second block's output", () => {
    const two = ["```python", "print(1)", "```", "", "```python", "print(2)", "```", ""].join("\n");
    const blocks = findRunnableBlocks(two);
    const second = blocks[1];
    if (second === undefined) throw new Error("fixture");
    const withSecond = insertOutput({ text: two, block: second, rendered: RENDERED, runsFolder: RUNS }).text;

    const first = findRunnableBlocks(withSecond)[0];
    if (first === undefined) throw new Error("fixture");
    const both = insertOutput({
      text: withSecond,
      block: first,
      rendered: renderOutputBlock({ summary: "first", stdout: "1", stderr: "", truncated: false, figures: [] }),
      runsFolder: RUNS,
    });
    expect(both.replaced).toBeNull();
    expect(both.text.match(/scdb-run/g)?.length).toBe(2);
  });
});

describe("taking output away again", () => {
  it("removes the fence and its figures, and nothing else", () => {
    const once = insertOutput({ text: NOTE, block: firstBlock(NOTE), rendered: RENDERED, runsFolder: RUNS }).text;
    const cleared = clearOutput({ text: once, block: firstBlock(once), runsFolder: RUNS });
    expect(cleared.removed).not.toBeNull();
    expect(cleared.text).not.toContain("scdb-run");
    expect(cleared.text).toContain("Prose the person wrote.");
    expect(findRunnableBlocks(cleared.text)).toHaveLength(1);
  });

  it("does nothing when there is nothing to remove", () => {
    expect(clearOutput({ text: NOTE, block: firstBlock(NOTE), runsFolder: RUNS }).text).toBe(NOTE);
  });
});
