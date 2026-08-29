import { describe, expect, it } from "vitest";

import {
  buildExportPage,
  buildFrame,
  escapeForScript,
  escapeHtml,
  safeCssValue,
  themeCss,
  wrapSource,
} from "./frame";

const RUNTIME = "globalThis.__scdbRuntime = {};";

function frame(source: string, theme: Record<string, string> = {}) {
  return buildFrame({ runtime: RUNTIME, source, title: "An app", theme });
}

describe("embedding app source in a page (§5.13)", () => {
  /**
   * The app body is JavaScript a person wrote, and a string containing this
   * sequence would otherwise close the script element early and spill the rest
   * of the file into the page as markup.
   */
  it("stops a closing script tag in a string from ending the script", () => {
    const escaped = escapeForScript(`const s = "</script>";`);
    expect(escaped).not.toMatch(/<\/script/i);
    expect(escaped).toContain("<\\/script");
  });

  it("catches the sequence whatever its case, and with attributes after it", () => {
    expect(escapeForScript("</SCRIPT >")).not.toMatch(/<\/script/i);
    expect(escapeForScript("</script foo>")).not.toMatch(/<\/script/i);
  });

  it("neutralises an HTML comment opener", () => {
    expect(escapeForScript("a <!-- b")).toBe("a <\\!-- b");
  });

  it("escapes the source when it goes into the page", () => {
    const page = frame(`const s = "</script><img>";`);
    expect(page).not.toMatch(/<\/script><img>/);
  });

  it("gives the app its own scope so it cannot collide with the runtime", () => {
    const wrapped = wrapSource("const html2 = 1;");
    expect(wrapped).toContain("(async (rt) =>");
    expect(wrapped).toContain("globalThis.__scdbRuntime");
  });

  /** §5.13: an error before the first render must be said out loud, not left blank. */
  it("routes a failure during startup to the runtime's reporter", () => {
    expect(wrapSource("throw new Error('x');")).toContain(".catch(globalThis.__scdbRuntime.fail)");
  });
});

describe("the page's own guards", () => {
  /**
   * `sandbox` with `allow-scripts` does not stop `fetch()`, and an image
   * source with data in the query string is a perfectly good exfiltration
   * channel. Rules 3 and 4 rest on this header, not on the attribute.
   */
  it("blocks every outbound channel with a content security policy", () => {
    const page = frame("mount(A);");
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("form-action 'none'");
    expect(page).toContain("base-uri 'none'");
  });

  it("carries a mount point and the runtime", () => {
    const page = frame("mount(A);");
    expect(page).toContain('<div id="app"></div>');
    expect(page).toContain(RUNTIME);
  });

  it("escapes the title rather than letting it write markup", () => {
    const page = buildFrame({
      runtime: RUNTIME,
      source: "",
      title: '"><script>x()</script>',
      theme: {},
    });
    expect(page).not.toContain("<script>x()");
    expect(escapeHtml('a<b>"&')).toBe("a&lt;b&gt;&quot;&amp;");
  });
});

describe("carrying Obsidian's theme into the frame (§6)", () => {
  it("copies the curated variables", () => {
    const css = themeCss({ "--text-normal": "#222", "--interactive-accent": "rgb(8, 109, 221)" });
    expect(css).toContain("--text-normal: #222;");
    expect(css).toContain("--interactive-accent: rgb(8, 109, 221);");
  });

  it("ignores a variable that is not on the list", () => {
    expect(themeCss({ "--something-else": "red" })).toBe("");
  });

  /**
   * Theme values are third-party CSS. A value carrying a closing brace would
   * end our rule and start writing its own.
   */
  it("drops a value that could break out of the rule", () => {
    expect(safeCssValue("#fff }")).toBe("");
    expect(safeCssValue("red; background: url(http://x)")).toBe("");
    expect(safeCssValue("url(http://tracker/pixel)")).toBe("");
    expect(safeCssValue("<script>")).toBe("");
    expect(themeCss({ "--text-normal": "#fff } body { display: none" })).toBe("");
  });

  it("keeps an ordinary font stack, commas and all", () => {
    expect(safeCssValue('-apple-system, "Segoe UI", sans-serif')).toBe(
      '-apple-system, "Segoe UI", sans-serif',
    );
  });
});

describe("the exported page (§5.13, §7 F3)", () => {
  const page = buildExportPage({
    runtime: RUNTIME,
    source: "mount(A);",
    title: "Turnaround explorer",
    theme: { "--text-normal": "#222" },
    rows: { "scdb-request": [{ id: "REQ-1" }] },
    takenAt: "2026-08-29",
    footer: "Snapshot taken 2026-08-29.",
  });

  it("carries its data with it, so it opens with no vault behind it", () => {
    expect(page).toContain("__scdbSnapshot");
    expect(page).toContain("REQ-1");
  });

  it("makes no external request of any kind", () => {
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
    expect(page).not.toMatch(/https?:\/\//);
  });

  it("says what it is and when it was taken", () => {
    expect(page).toContain("Snapshot taken 2026-08-29.");
  });

  /** The data is a note's frontmatter. It must never be read as code. */
  it("embeds the snapshot as a parsed string, not as a live object literal", () => {
    const hostile = buildExportPage({
      runtime: RUNTIME,
      source: "",
      title: "x",
      theme: {},
      rows: { note: [{ title: "</script><img src=x onerror=alert(1)>" }] },
      takenAt: "2026-08-29",
      footer: "",
    });
    expect(hostile).toContain("JSON.parse(");
    expect(hostile).not.toMatch(/<\/script><img/);
  });
});
