/**
 * Just enough XML to read an RSS feed and a sitemap. Pure.
 *
 * **Why not `DOMParser`.** `domain/` is deliberately free of both Obsidian and
 * the browser so it unit-tests in milliseconds under plain Node (§4). Reaching
 * for `DOMParser` here would drag a DOM into every test that touches a feed,
 * and building a document out of a remote response is a larger surface than
 * this needs.
 *
 * **Why not an XML library.** The bundle budget is ~1.5 MB and we are already
 * at 806 KB. A parser is a dependency to ask for; what these two formats
 * actually require is "find every `<item>`, read four fields out of it", and
 * that is this file.
 *
 * **What it deliberately does not do:** namespaces are matched as literal name
 * text (`dc:creator` is the element name, not a resolved namespace), nested
 * elements of the same name are not supported, and nothing here validates. It
 * reads well-formed feeds and sitemaps, and returns nothing rather than
 * guessing on anything else. Callers check for emptiness.
 *
 * Scanning is `indexOf`-based rather than regular expressions. A remote
 * response is untrusted input, and a backtracking regex over a megabyte of it
 * is a way to hang the UI thread from the far end of a network connection.
 */

/** The five entities XML defines, plus the ones a CMS emits constantly. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  deg: "°",
};

/**
 * Decode character references.
 *
 * Numeric references are capped at the Unicode maximum and anything outside it
 * is left as written rather than throwing — a malformed feed should degrade to
 * odd-looking text, never to an exception in the middle of a fetch.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Unwrap `<![CDATA[…]]>` sections, of which WordPress emits a great many. */
export function stripCdata(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<![CDATA[", at);
    if (open === -1) {
      out += text.slice(at);
      return out;
    }
    out += text.slice(at, open);
    const close = text.indexOf("]]>", open + 9);
    if (close === -1) {
      // Unterminated: take the rest as content rather than dropping it.
      out += text.slice(open + 9);
      return out;
    }
    out += text.slice(open + 9, close);
    at = close + 3;
  }
}

/** Remove any remaining markup. Feeds put HTML inside `description`. */
export function stripTags(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<", at);
    if (open === -1) return out + text.slice(at);
    out += text.slice(at, open);
    const close = text.indexOf(">", open);
    if (close === -1) return out;
    at = close + 1;
  }
}

/** True when `xml` looks like markup at all, so a 404 HTML page is caught. */
export function looksLikeXml(xml: string): boolean {
  const head = xml.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<");
}

/**
 * The inner content of every `<name>…</name>`, in document order.
 *
 * Matches the element name literally, so `<dc:creator>` is found by asking for
 * `"dc:creator"`. A self-closing `<name/>` yields an empty string, because the
 * element is present and empty — which is different from absent.
 */
export function elements(xml: string, name: string): string[] {
  const found: string[] = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start === -1) return found;

    // `<item>` must not match `<items>`: the next character has to end the name.
    const after = xml[start + open.length];
    if (after !== undefined && after !== ">" && after !== "/" && !/\s/.test(after)) {
      at = start + open.length;
      continue;
    }

    const tagEnd = xml.indexOf(">", start);
    if (tagEnd === -1) return found;
    if (xml[tagEnd - 1] === "/") {
      found.push("");
      at = tagEnd + 1;
      continue;
    }

    const end = xml.indexOf(close, tagEnd + 1);
    if (end === -1) return found;
    found.push(xml.slice(tagEnd + 1, end));
    at = end + close.length;
  }
}

/**
 * The decoded text of the first `<name>` inside `fragment`, or `""`.
 *
 * **CDATA, then tags, then entities — and the order is load-bearing.** Decoding
 * first turns `&lt;p&gt;` into `<p>`, which the tag strip then deletes; but
 * that sequence was text the feed deliberately escaped in order to *show* it,
 * and deleting it silently corrupts a title. Stripping first removes only
 * markup that was really markup, and the decode afterwards can only produce
 * text. A test pins this, because it is the kind of ordering a later tidy-up
 * would swap without noticing.
 */
export function textOf(fragment: string, name: string): string {
  const first = elements(fragment, name)[0];
  if (first === undefined) return "";
  return decodeEntities(stripTags(stripCdata(first))).trim();
}

/** The value of one attribute on the first `<name>` tag, or `""`. */
export function attrOf(fragment: string, name: string, attribute: string): string {
  const start = fragment.indexOf(`<${name}`);
  if (start === -1) return "";
  const tagEnd = fragment.indexOf(">", start);
  if (tagEnd === -1) return "";
  const tag = fragment.slice(start, tagEnd);
  const marker = `${attribute}="`;
  const at = tag.indexOf(marker);
  if (at === -1) return "";
  const from = at + marker.length;
  const to = tag.indexOf('"', from);
  if (to === -1) return "";
  return decodeEntities(tag.slice(from, to));
}
