import { describe, expect, it } from "vitest";

import { findFence, renderFence, replaceFence } from "./fence";

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
