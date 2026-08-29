/**
 * Building the page a vault app runs in (§5.13, §7 F3).
 *
 * Two pages come out of here and they share almost everything: the `srcdoc` of
 * the sandboxed iframe inside Obsidian, and the self-contained HTML file an
 * app is exported as. Both are assembled from the same three parts — the
 * runtime bundle, the app's own source, and some CSS — which is why they live
 * together: a divergence between them would mean an app behaving one way for
 * you and another way for whoever you sent it to.
 *
 * Three things here are load-bearing and each is tested:
 *
 *  1. **`</script>` in app source must not end the script element.** The app
 *     body is JavaScript written by a person, and a string containing that
 *     sequence would otherwise close the element early and drop the rest of
 *     the file into the page as markup. Escaped, not rejected — it is a
 *     perfectly reasonable thing to have in a string.
 *  2. **`sandbox` alone does not stop a network call.** A sandboxed frame with
 *     `allow-scripts` can still `fetch()` a public URL, or set an image source
 *     with data in the query string. Rules 3 and 4 are not satisfied by the
 *     sandbox attribute — they are satisfied by the Content-Security-Policy
 *     below, which is why it is a `default-src 'none'` policy and not a
 *     decoration.
 *  3. **Theme values are sanitised.** They arrive from the host's computed
 *     styles, which come from whatever theme the vault is wearing, which is
 *     third-party CSS. A value carrying a closing brace would end our rule and
 *     start writing its own.
 *
 * Pure module: no Obsidian, no Node, no DOM.
 */

/**
 * Neutralise sequences that would end the script element early.
 *
 * `<\/script` is valid inside every JavaScript context the sequence can
 * legitimately appear in — a string, a template, a regular expression, a
 * comment — so this changes what the HTML parser sees without changing what
 * the JavaScript engine reads.
 */
export function escapeForScript(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** Escape text going into an HTML text node or attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The Obsidian custom properties copied into the frame.
 *
 * A curated set, not everything: §5.13 says a curated set, and copying the
 * hundreds a theme defines would put a theme's whole cascade inside a document
 * that has none of its structure. These are the ones §6 names plus what an app
 * needs to draw a table and a control.
 */
export const THEME_VARIABLES: readonly string[] = [
  "--background-primary",
  "--background-primary-alt",
  "--background-secondary",
  "--background-modifier-border",
  "--background-modifier-hover",
  "--text-normal",
  "--text-muted",
  "--text-faint",
  "--text-error",
  "--text-accent",
  "--interactive-accent",
  "--interactive-accent-hover",
  "--interactive-normal",
  "--interactive-hover",
  "--font-text",
  "--font-monospace",
  "--font-text-size",
  "--radius-s",
  "--radius-m",
];

/**
 * A CSS value we are willing to copy into the frame.
 *
 * Anything that could end the declaration or the rule is dropped whole rather
 * than escaped: a theme variable is a colour or a font stack, and one that
 * contains a brace is not a value we failed to escape, it is a value we do not
 * understand.
 */
export function safeCssValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 200) return "";
  if (/[<>{};@\\]/.test(trimmed)) return "";
  if (/url\s*\(/i.test(trimmed)) return "";
  return trimmed;
}

/** The `:root { … }` block carrying the host's theme into the frame. */
export function themeCss(values: Record<string, string>): string {
  const lines: string[] = [];
  for (const name of THEME_VARIABLES) {
    if (!/^--[a-z0-9-]+$/i.test(name)) continue;
    const value = safeCssValue(values[name] ?? "");
    if (value === "") continue;
    lines.push(`  ${name}: ${value};`);
  }
  return lines.length === 0 ? "" : `:root {\n${lines.join("\n")}\n}`;
}

/**
 * The stylesheet every app page carries.
 *
 * Deliberately small. It makes an app that renders a plain table look like
 * part of Obsidian (§6) and gives the error box somewhere to live; it does not
 * try to be a component library. Falls back to readable defaults so an
 * exported page, which has no host to send theme values, still looks right.
 */
const BASE_CSS = `
:root {
  color-scheme: light dark;
}
html, body {
  margin: 0;
  padding: 0;
  background: var(--background-primary, #fff);
  color: var(--text-normal, #222);
  font-family: var(--font-text, -apple-system, "Segoe UI", sans-serif);
  font-size: var(--font-text-size, 15px);
  line-height: 1.5;
}
#app { padding: 16px; }
h1, h2, h3 { margin: 0 0 8px; line-height: 1.3; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border, #ddd); }
td.num, th.num { text-align: right; }
button {
  font: inherit;
  padding: 4px 10px;
  border-radius: var(--radius-s, 4px);
  border: 1px solid var(--background-modifier-border, #ccc);
  background: var(--interactive-normal, #f2f2f2);
  color: var(--text-normal, #222);
  cursor: pointer;
}
button:hover { background: var(--interactive-hover, #e8e8e8); }
input, select, textarea {
  font: inherit;
  color: var(--text-normal, #222);
  background: var(--background-primary, #fff);
  border: 1px solid var(--background-modifier-border, #ccc);
  border-radius: var(--radius-s, 4px);
  padding: 3px 6px;
}
code, pre { font-family: var(--font-monospace, ui-monospace, monospace); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.scdb-app-error {
  border: 1px solid var(--text-error, #c00);
  border-radius: var(--radius-m, 6px);
  padding: 12px;
  color: var(--text-error, #c00);
}
.scdb-app-error pre { margin: 8px 0 0; color: var(--text-muted, #666); }
.scdb-app-note { color: var(--text-muted, #666); font-size: 0.9em; }
`.trim();

/**
 * The policy the frame runs under.
 *
 * `default-src 'none'` and an explicit `connect-src 'none'` are what actually
 * make rules 3 and 4 true for an app: no fetch, no XHR, no WebSocket, no
 * beacon, no image pointing at a host with the data in its query string.
 * `'unsafe-inline'` is required because everything the page runs is inline —
 * there is no origin it could load a file from, which is the point.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Wrap the app's source so its declarations cannot collide with the runtime's.
 *
 * The runtime and the app end up in one module — there is no second file to
 * import, because an opaque-origin frame cannot fetch one. Putting the app
 * inside a function gives it a scope of its own, makes `await` available at
 * its top level, and means the names it is handed arrive as parameters rather
 * than as globals it could accidentally shadow at module level.
 */
export function wrapSource(source: string): string {
  return [
    ";(async (rt) => {",
    "const { html, h, render, mount, fail, useState, useEffect, useMemo, useRef, useCallback,",
    "        useQuery, useNotes, useProposeWrite, query, notes, proposeWrite, snapshotTakenAt } = rt;",
    escapeForScript(source),
    "})(globalThis.__scdbRuntime).catch(globalThis.__scdbRuntime.fail);",
  ].join("\n");
}

export interface FrameInput {
  /** The bundled sandbox runtime, as source text. */
  runtime: string;
  /** The app's JavaScript, straight from its note. */
  source: string;
  title: string;
  /** Obsidian custom properties, already read from the host. */
  theme: Record<string, string>;
}

/** The `srcdoc` for the sandboxed iframe. */
export function buildFrame(input: FrameInput): string {
  return page({
    title: input.title,
    csp: CSP,
    extraCss: themeCss(input.theme),
    prelude: "",
    runtime: input.runtime,
    source: input.source,
  });
}

export interface ExportInput {
  runtime: string;
  source: string;
  title: string;
  theme: Record<string, string>;
  /** Rows by note type, already filtered to what may leave the vault. */
  rows: Record<string, unknown[]>;
  takenAt: string;
  /** Shown at the foot of the page: what this is and when it was taken. */
  footer: string;
}

/**
 * A self-contained HTML file: the app, plus a snapshot of the data it was
 * granted (§5.13).
 *
 * No sandbox attribute and no broker — there is no vault behind this page and
 * nothing for it to reach. The CSP stays, because the page still contains code
 * that came from a note and it should not be able to call home from a
 * colleague's laptop either.
 */
export function buildExportPage(input: ExportInput): string {
  const snapshot = JSON.stringify({ rows: input.rows, takenAt: input.takenAt });
  return page({
    title: input.title,
    csp: CSP,
    extraCss: themeCss(input.theme),
    // JSON is embedded through a string literal rather than as a bare object
    // so that no value inside it can be read as code.
    prelude: `globalThis.__scdbSnapshot = JSON.parse(${JSON.stringify(snapshot)});`,
    runtime: input.runtime,
    source: input.source,
    footer: input.footer,
  });
}

function page(parts: {
  title: string;
  csp: string;
  extraCss: string;
  prelude: string;
  runtime: string;
  source: string;
  footer?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(parts.csp)}">
<title>${escapeHtml(parts.title)}</title>
<style>
${BASE_CSS}
${parts.extraCss}
</style>
</head>
<body>
<div id="app"></div>
${parts.footer === undefined ? "" : `<footer class="scdb-app-note">${escapeHtml(parts.footer)}</footer>\n`}<script type="module">
${escapeForScript(parts.prelude)}
${escapeForScript(parts.runtime)}
${wrapSource(parts.source)}
</script>
</body>
</html>
`;
}
