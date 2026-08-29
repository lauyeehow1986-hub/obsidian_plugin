import { describe, expect, it } from "vitest";

import { findFence, renderFence, replaceFence, scanFences } from "./fence";

const APP = { languages: ["js", "javascript"] as const, tag: "app" };

describe("fenced blocks in a note body", () => {
  it("finds the tagged fence among others in the same language", () => {
    const body = ["```js", "// prose example", "```", "", "```js app", "mount(A);", "```"].join("\n");
    expect(findFence(body, APP)?.body).toBe("mount(A);\n");
    expect(findFence(body, APP)?.tagged).toBe(true);
  });

  it("accepts either spelling of the language", () => {
    expect(findFence("```javascript app\nmount(A);\n```", APP)?.tagged).toBe(true);
  });

  it("ignores a fence in another language entirely", () => {
    expect(findFence("```python\nprint(1)\n```", APP)).toBeNull();
  });

  /**
   * An app that prints a markdown example would otherwise close its own block
   * halfway and leave the rest of the code sitting in the note as prose.
   */
  it("grows the fence when the body contains one", () => {
    const source = "const md = '```yaml\\nx: 1\\n```';";
    const rendered = renderFence(source, "js", "app");
    expect(rendered.startsWith("````js app")).toBe(true);
    expect(findFence(rendered, APP)?.body.trim()).toBe(source);
  });

  it("appends at the end when there is no block, so the prose stays on top", () => {
    const after = replaceFence("# An app\n\nWhat it does.\n", "mount(A);", APP, "js");
    expect(after.indexOf("What it does.")).toBeLessThan(after.indexOf("```js app"));
  });
});

describe("scanning every fence (F1 needs all of them, not the first)", () => {
  const text = [
    "```python",
    "print(1)",
    "```",
    "",
    "```",
    "a bare fence",
    "```",
    "",
    "~~~r extra",
    "1 + 1",
    "~~~",
    "",
  ].join("\n");

  it("returns them in document order, bare fences included", () => {
    expect(scanFences(text).map((fence) => fence.words)).toEqual([["python"], [], ["r", "extra"]]);
  });

  it("lower-cases the info string, so RScript and R both match later", () => {
    expect(scanFences("```PYTHON\nx\n```\n")[0]?.words).toEqual(["python"]);
  });

  it("gives ranges that slice back to the whole fence", () => {
    const first = scanFences(text)[0];
    if (first === undefined) throw new Error("fixture");
    expect(text.slice(first.start, first.end)).toBe("```python\nprint(1)\n```");
  });

  it("finds nothing in prose", () => {
    expect(scanFences("Just words.\n")).toEqual([]);
  });
});

describe("rendering without a tag", () => {
  // A trailing space in the info string would show up in the fence of every
  // archived run record, and in the git diff of every one of them.
  it("leaves no trailing space after the language", () => {
    expect(renderFence("print(1)", "python", "")).toBe("```python\nprint(1)\n```");
  });
});

