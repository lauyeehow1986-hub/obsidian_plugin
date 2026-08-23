/**
 * HTML → plain text, for an email that carries no `text/plain` part.
 *
 * Corporate mail is very often `text/html` only, so without this an imported
 * message would land in the vault as a wall of markup. This is deliberately a
 * *reduction*, not a rendering: enough structure to read the message back, and
 * nothing that could execute or fetch.
 *
 * **String work only, never the DOM.** §8 forbids `innerHTML` with
 * vault-derived content, and an email body is the most untrusted text this
 * plugin handles (§2 rule 5). Parsing it with `DOMParser` or a detached element
 * would load remote images the moment the document was constructed — a silent
 * network call, on content an attacker chose, which rule 3 forbids outright.
 * Regex over a string cannot do that.
 *
 * Pure module: no Obsidian, no Node.
 */

/** Entities common enough in mail to be worth naming. Everything else falls to the numeric forms. */
const NAMED_ENTITIES: Record<string, string> = {
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
  bull: "•",
  middot: "·",
  pound: "£",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

/**
 * Decode HTML entities.
 *
 * Numeric references are clamped to valid code points: `&#1114112;` is not a
 * character, and `String.fromCodePoint` throws on it rather than returning
 * something harmless. An email that crashed the importer on a malformed entity
 * would be an import nobody could complete and nobody could explain.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
      // Surrogate halves are not characters on their own and produce a lone
      // surrogate that later breaks JSON and file writes.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Tags whose *content* is markup or code, not prose, and must go with them. */
const DROP_WITH_CONTENT = /<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Tags that end a line when they close.
 *
 * `li` is deliberately absent: the opening `<li>` already starts a line, so
 * closing one too puts a blank line between every bullet and a five-item list
 * arrives double-spaced across half a screen.
 */
const BLOCK_END = /<\/(p|div|tr|ul|ol|h[1-6]|blockquote|table|section|article|pre)\s*>/gi;

/**
 * Reduce an HTML body to readable text.
 *
 * The output is plain text destined for a markdown note, not markdown itself:
 * no attempt is made to turn `<strong>` into `**`, because an email signature
 * full of bold and colour would then arrive as unreadable punctuation. The one
 * exception is list items, where a leading `- ` is what makes a list legible at
 * all.
 */
export function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(DROP_WITH_CONTENT, "");

  // Structure, before the tags are stripped and the boundaries are lost.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(BLOCK_END, "\n");
  text = text.replace(/<(p|div|tr|h[1-6]|blockquote|table)\b[^>]*>/gi, "\n");

  // Cell boundaries become a tab so a table does not run into one word.
  text = text.replace(/<\/t[dh]\s*>/gi, "\t");

  text = text.replace(/<[^>]*>/g, "");
  text = decodeEntities(text);

  return tidy(text);
}

/**
 * Collapse the whitespace HTML sources are full of.
 *
 * A mail client's HTML is indented, so every line arrives with leading spaces
 * and the message reads as though it were code. Blank runs are collapsed to one
 * blank line rather than removed: paragraph breaks are the only structure the
 * reduction above preserves.
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // A literal non-breaking space survives tag stripping and then defeats
    // every `trim()` below, leaving lines that look wrongly indented.
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
