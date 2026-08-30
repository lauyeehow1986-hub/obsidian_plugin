/**
 * `.eml` parsing — RFC 5322 headers and MIME bodies (CLAUDE.md §5.10, email
 * Tier 1).
 *
 * Sits between Tier 0, where the plugin only knows what it composed itself, and
 * E2's Outlook COM bridge. A saved message is a file: it goes into the vault,
 * this reads it, and a correspondence thread comes out. **No mailbox access, no
 * credentials, no network** — the same shape as the `.ics` bridge in §7 B3, and
 * the same reason it needs no dependency.
 *
 * ## Bytes in, not a string
 *
 * The entry point takes `Uint8Array` rather than text, because a message
 * declares its own charset per part. Reading the file as UTF-8 first and
 * parsing the result would corrupt every `windows-1252` body before this module
 * ever saw it, and those are the ones with the £ signs and the smart quotes an
 * institutional mailbox is full of.
 *
 * Internally the bytes become a **latin1 string** for all structural work.
 * Byte↔charCode is a bijection over 0–255, so nothing is lost and boundary
 * scanning becomes ordinary string work; the leaves convert back to bytes
 * before the real charset decode.
 *
 * ## What this deliberately does not do
 *
 * S/MIME signed and encrypted mail is recognised and reported, never guessed
 * at: `application/pkcs7-mime` is opaque without the private key, and a
 * `multipart/signed` message's real content is its first part. Nothing here
 * verifies a signature, and the note must not imply that it did.
 *
 * Every message parsed here is **untrusted text** (§2 rule 5). This module
 * returns data. It never decides anything.
 *
 * Pure module: no Obsidian, no Node. Uses `TextDecoder`, present in both
 * Electron and Node — the same standing as Web Crypto in `domain/id/ulid.ts`.
 */

import { htmlToText } from "./html";

/* ------------------------------------------------------------- bytes -- */

/** Bytes → a string where each char code is one byte. Lossless both ways. */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on
  // anything past a few hundred KB, and mail with a PDF attached is bigger.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** The inverse of `latin1`. Char codes above 255 cannot occur and are masked. */
export function unlatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode base64 to bytes.
 *
 * Hand-rolled rather than `atob`: that returns a binary *string* which then has
 * to be walked into bytes anyway, and it throws on the stray characters real
 * mail contains. Anything outside the alphabet — line breaks, spaces, a `=`
 * mid-stream from a mangled forward — is skipped rather than fatal.
 */
export function decodeBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let length = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < text.length; i++) {
    const value = BASE64_INDEX[text.charCodeAt(i) & 0xff]!;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
    }
  }

  return out.subarray(0, length);
}

/**
 * Decode quoted-printable to bytes.
 *
 * `=` at end of line is a soft break and disappears with the newline. `=XX` is
 * one byte. A lone `=` that is neither — which Outlook produces when a line was
 * re-wrapped by something downstream — is kept verbatim rather than swallowing
 * the two characters after it.
 */
export function decodeQuotedPrintable(text: string): Uint8Array {
  const out: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== "=") {
      out.push(char.charCodeAt(0) & 0xff);
      continue;
    }

    const next = text[i + 1];
    if (next === "\n") {
      i += 1;
      continue;
    }
    if (next === "\r" && text[i + 2] === "\n") {
      i += 2;
      continue;
    }

    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(0x3d);
  }

  return Uint8Array.from(out);
}

/**
 * The windows-1252 family, decoded by hand rather than by `TextDecoder`.
 *
 * Node and Chromium disagree here, and this plugin has to run in both: the
 * WHATWG encoding standard maps byte 0x92 to a right single quote, and
 * Chromium does, but Node's ICU decodes the whole 0x80–0x9F range as C1 control
 * characters. The difference is invisible until an ordinary Outlook message
 * arrives full of smart quotes, en dashes and ellipses — which is to say,
 * always.
 *
 * A vault is a record. The same file must import to the same text on the dev
 * machine and on the work laptop, so the sixteen-by-two bytes the two
 * implementations argue about are mapped here and the argument stops. Every
 * other byte in this family is its own code point, exactly as in latin-1.
 *
 * WHATWG treats `iso-8859-1` and `us-ascii` as aliases of `windows-1252`, and
 * so does this: mail labelled `iso-8859-1` that carries a 0x92 meant a quote,
 * not a control character nobody can type.
 */
const CP1252_HIGH = [
  "\u20ac", "\u0081", "\u201a", "\u0192", "\u201e", "\u2026", "\u2020", "\u2021",
  "\u02c6", "\u2030", "\u0160", "\u2039", "\u0152", "\u008d", "\u017d", "\u008f",
  "\u0090", "\u2018", "\u2019", "\u201c", "\u201d", "\u2022", "\u2013", "\u2014",
  "\u02dc", "\u2122", "\u0161", "\u203a", "\u0153", "\u009d", "\u017e", "\u0178",
];

const CP1252_LABELS = new Set([
  "windows-1252",
  "cp1252",
  "cp-1252",
  "ansi_x3.4-1968",
  "iso-8859-1",
  "iso8859-1",
  "iso_8859-1",
  "latin1",
  "latin-1",
  "l1",
  "us-ascii",
  "ascii",
]);

function decodeCp1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Decode bytes in a declared charset.
 *
 * An unknown label is a `RangeError` from `TextDecoder`, not a silent fallback,
 * so it is caught here and reported. UTF-8 is the substitute because it is
 * right far more often than it is wrong, and `fatal: false` means a genuinely
 * mis-declared body arrives with replacement characters rather than not at all.
 */
export function decodeText(bytes: Uint8Array, charset: string, problems: string[]): string {
  const declared = charset.trim() === "" ? "utf-8" : charset.trim();
  if (CP1252_LABELS.has(declared.toLowerCase())) return decodeCp1252(bytes);

  try {
    return new TextDecoder(declared, { fatal: false }).decode(bytes);
  } catch {
    // Reported exactly as the message spelled it, so it can be found in the
    // file. A lower-cased echo of a header the user never typed is one more
    // thing to reconcile before they can act on the warning.
    problems.push(
      `Character set "${declared}" is not one this build can decode; read it as UTF-8.`,
    );
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/* ----------------------------------------------------------- headers -- */

export interface EmlHeader {
  /** Lower-cased field name. */
  name: string;
  /** Unfolded, still RFC 2047 encoded. */
  value: string;
}

/** Split a message or part into its header block and its raw body. */
export function splitHeaders(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");

  // Whichever blank line comes first wins: a message with CRLF headers and an
  // LF-normalised body (what happens when a file is copied through a text tool)
  // otherwise loses either its headers or half its body.
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { head: raw.slice(0, crlf), body: raw.slice(crlf + 4) };
  }
  if (lf !== -1) return { head: raw.slice(0, lf), body: raw.slice(lf + 2) };
  return { head: raw, body: "" };
}

/**
 * Unfold a header block into fields.
 *
 * RFC 5322 §2.2.3: a line starting with space or tab continues the one before.
 * The folding whitespace is kept as a single space, because it is real
 * whitespace inside the field value — dropping it runs two words together in a
 * long subject.
 */
export function parseHeaders(head: string): EmlHeader[] {
  const headers: EmlHeader[] = [];
  let current: string | null = null;

  for (const line of head.split(/\r\n|\n|\r/)) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && current !== null) {
      current += " " + line.trim();
      continue;
    }
    if (current !== null) headers.push(field(current));
    current = line;
  }
  if (current !== null) headers.push(field(current));

  return headers;
}

function field(line: string): EmlHeader {
  const colon = line.indexOf(":");
  if (colon < 1) return { name: "", value: line.trim() };
  return { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
}

export function headerValue(headers: readonly EmlHeader[], name: string): string {
  return headers.find((header) => header.name === name)?.value ?? "";
}

/* ------------------------------------------------- RFC 2047 encoding -- */

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * Decode RFC 2047 encoded words in a header value.
 *
 * Whitespace *between* two encoded words is dropped (RFC 2047 §6.2): a long
 * subject is split across several words at arbitrary points, and keeping the
 * separator inserts a space into the middle of a word. Whitespace between an
 * encoded word and ordinary text is kept, because there it is real.
 */
export function decodeEncodedWords(value: string, problems: string[] = []): string {
  if (!value.includes("=?")) return value;

  // Collapse the separator first, so the pass below sees the words adjacent.
  const joined = value.replace(/(\?=)[ \t]+(=\?)/g, "$1$2");

  return joined.replace(ENCODED_WORD, (match, charset: string, kind: string, text: string) => {
    const bytes =
      kind.toUpperCase() === "B"
        ? decodeBase64(text)
        : // In the Q encoding — and only there — an underscore is a space.
          decodeQuotedPrintable(text.replace(/_/g, " "));
    const decoded = decodeText(bytes, charsetOf(charset), problems);
    // A word that decodes to nothing usable is more legible left as it was
    // than replaced with an empty string in the middle of a subject line.
    return decoded === "" && text !== "" ? match : decoded;
  });
}

/** `utf-8*en` and `UTF-8` are the same charset; the language tag is not one. */
function charsetOf(label: string): string {
  return label.split("*")[0]!.trim();
}

/* ---------------------------------------------------------- addresses -- */

export interface EmlAddress {
  /** Display name, decoded. "" when the header carried none. */
  name: string;
  /** The addr-spec, exactly as written. */
  address: string;
  /** Case-folded address — two headers naming one mailbox share this. */
  key: string;
}

/**
 * Split an address list on the commas that actually separate addresses.
 *
 * A display name may contain a comma — `"Tan, A (Dr)" <a.tan@example.org>` is
 * ordinary — so a plain `split(",")` produces two broken addresses out of one
 * good one, and the thread ends up attributed to a person who does not exist.
 */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let comment = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;

    if (quoted) {
      if (char === "\\" && i + 1 < value.length) {
        current += char + value[++i];
        continue;
      }
      if (char === '"') quoted = false;
      current += char;
      continue;
    }

    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "<") angle += 1;
    if (char === ">") angle = Math.max(0, angle - 1);
    if (char === "(") comment += 1;
    if (char === ")") comment = Math.max(0, comment - 1);

    if ((char === "," || char === ";") && angle === 0 && comment === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * Read one address.
 *
 * A group name (`Undisclosed recipients:`) and a bare word with no `@` both
 * yield nothing: an entry that is not a mailbox cannot be corresponded with,
 * and putting it in `with:` would age a thread against a party who could never
 * reply.
 */
export function parseAddress(entry: string): EmlAddress | null {
  const angleStart = entry.lastIndexOf("<");
  const angleEnd = entry.lastIndexOf(">");

  let name = "";
  let address = "";

  if (angleStart !== -1 && angleEnd > angleStart) {
    address = entry.slice(angleStart + 1, angleEnd).trim();
    name = entry.slice(0, angleStart).trim();
  } else {
    address = entry.replace(/\([^)]*\)/g, "").trim();
  }

  name = decodeEncodedWords(name).trim().replace(/^"(.*)"$/s, "$1").trim();
  // A name that is just the address again adds nothing and reads as noise.
  if (name.toLowerCase() === address.toLowerCase()) name = "";

  if (!address.includes("@")) return null;
  return { name, address, key: address.toLowerCase() };
}

export function parseAddressList(value: string): EmlAddress[] {
  const seen = new Set<string>();
  const addresses: EmlAddress[] = [];

  for (const entry of splitAddressList(value)) {
    const parsed = parseAddress(entry);
    if (parsed === null || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    addresses.push(parsed);
  }

  return addresses;
}

/* --------------------------------------------------------------- dates -- */

/**
 * Read an RFC 5322 `Date:` header.
 *
 * `Date.parse` handles the RFC 2822 form, including the obsolete zone names, so
 * the work here is stripping the trailing `(GMT+08:00)`-style comment Outlook
 * appends, which defeats it. Unreadable returns null and the caller falls back
 * to something it can defend, never to "now".
 */
export function parseMailDate(value: string): number | null {
  const cleaned = value.replace(/\([^)]*\)/g, "").trim();
  if (cleaned === "") return null;
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : null;
}

/** `<abc@host>` → `abc@host`. Message ids are compared, so the brackets go. */
export function stripAngles(value: string): string {
  return value.trim().replace(/^<|>$/g, "").trim();
}

/** Every id in a `References:` header, in the order the header listed them. */
export function parseReferences(value: string): string[] {
  return (value.match(/<[^<>]+>/g) ?? []).map(stripAngles).filter((id) => id !== "");
}

/* ---------------------------------------------------------- MIME tree -- */

export interface ContentType {
  /** Lower-cased `type/subtype`, defaulting to `text/plain` per RFC 2045. */
  mimeType: string;
  params: Record<string, string>;
}

/**
 * Parse a `Content-Type` or `Content-Disposition` value with its parameters.
 *
 * Handles RFC 2231 continuations and extended values — `filename*0*=`,
 * `filename*1=`, `filename*=utf-8''…`. Outlook produces them for any attachment
 * whose name is long or non-ASCII, which on an institutional mailbox is most of
 * the interesting ones.
 */
export function parseContentType(value: string, fallback: string): ContentType {
  const [head, ...rest] = splitParams(value);
  const mimeType = (head ?? "").trim().toLowerCase() || fallback;

  const continued = new Map<string, { parts: Map<number, string>; charset: string }>();
  const params: Record<string, string> = {};

  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;

    const rawName = part.slice(0, eq).trim().toLowerCase();
    let raw = part.slice(eq + 1).trim();
    if (raw.startsWith('"')) raw = raw.slice(1, raw.endsWith('"') ? -1 : undefined);

    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawName);
    if (match === null) continue;
    const [, name, index, extended] = match;

    if (index === undefined && extended === undefined) {
      params[name!] = raw;
      continue;
    }

    const entry = continued.get(name!) ?? { parts: new Map<number, string>(), charset: "" };
    let text = raw;
    if (extended !== undefined) {
      // RFC 2231 §4: charset'language'percent-encoded-value, and only the
      // first segment of a continuation carries the charset.
      const bits = raw.split("'");
      if (bits.length >= 3 && (index === undefined || index === "0")) {
        entry.charset = bits[0]!;
        text = bits.slice(2).join("'");
      }
      text = percentDecode(text);
    }
    entry.parts.set(index === undefined ? 0 : Number(index), text);
    continued.set(name!, entry);
  }

  for (const [name, entry] of continued) {
    const ordered = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]);
    const joined = ordered.map(([, text]) => text).join("");
    params[name] =
      entry.charset === ""
        ? joined
        : decodeText(unlatin1(joined), entry.charset, []);
  }

  return { mimeType, params };
}

/** `%E2%82%AC` → the raw bytes, kept as latin1 so the charset step can decode them. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Split on the semicolons that separate parameters, not those inside quotes. */
function splitParams(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted) {
      if (char === "\\" && i + 1 < value.length) {
        current += value[++i];
        continue;
      }
      if (char === '"') {
        quoted = false;
        current += char;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === ";") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current);
  return parts;
}

export interface MimePart {
  headers: EmlHeader[];
  mimeType: string;
  charset: string;
  /** Lower-cased Content-Transfer-Encoding. */
  encoding: string;
  /** "attachment", "inline", or "". */
  disposition: string;
  filename: string;
  /** Content-ID with the angle brackets removed. */
  contentId: string;
  /** Still-encoded body, as latin1. Empty for a multipart. */
  raw: string;
  parts: MimePart[];
}

/**
 * How deep a MIME tree may go.
 *
 * A message that nests multiparts inside each other without end — malformed, or
 * deliberately so — would otherwise recurse until the stack gives out, and an
 * importer that crashes Obsidian on one bad file is worse than one that skips
 * it. Six is far past anything a real client produces.
 */
const MAX_DEPTH = 6;

export function parsePart(raw: string, depth = 0): MimePart {
  const { head, body } = splitHeaders(raw);
  const headers = parseHeaders(head);

  const type = parseContentType(headerValue(headers, "content-type"), "text/plain");
  const disposition = parseContentType(headerValue(headers, "content-disposition"), "");

  const part: MimePart = {
    headers,
    mimeType: type.mimeType,
    charset: type.params["charset"] ?? "",
    encoding: headerValue(headers, "content-transfer-encoding").trim().toLowerCase(),
    disposition: disposition.mimeType,
    filename: decodeEncodedWords(
      disposition.params["filename"] ?? type.params["name"] ?? "",
    ).trim(),
    contentId: stripAngles(headerValue(headers, "content-id")),
    raw: body,
    parts: [],
  };

  const boundary = type.params["boundary"] ?? "";
  if (part.mimeType.startsWith("multipart/") && boundary !== "" && depth < MAX_DEPTH) {
    part.parts = splitMultipart(body, boundary).map((chunk) => parsePart(chunk, depth + 1));
    part.raw = "";
  }

  return part;
}

/**
 * Split a multipart body on its boundary.
 *
 * The preamble before the first delimiter and the epilogue after the closing
 * one are discarded, which is what they are for: "This is a multi-part message
 * in MIME format." is not a part of the message anybody wants in their vault.
 */
export function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const chunks: string[] = [];
  const lines = body.split(/\r\n|\n/);

  let current: string[] | null = null;
  for (const line of lines) {
    if (line.trimEnd() === delimiter) {
      if (current !== null) chunks.push(current.join("\r\n"));
      current = [];
      continue;
    }
    if (line.trimEnd() === `${delimiter}--`) {
      if (current !== null) chunks.push(current.join("\r\n"));
      current = null;
      // Anything after the terminator is epilogue. Some clients then start a
      // second, unrelated boundary run; stopping here is the spec-correct read.
      break;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) chunks.push(current.join("\r\n"));

  return chunks;
}

/** A leaf part's bytes, with its transfer encoding undone. */
export function partBytes(part: MimePart): Uint8Array {
  switch (part.encoding) {
    case "base64":
      return decodeBase64(part.raw);
    case "quoted-printable":
      return decodeQuotedPrintable(part.raw);
    default:
      return unlatin1(part.raw);
  }
}

/* ------------------------------------------------------------ message -- */

export interface EmlAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Set for a part referenced from the HTML body rather than listed by the client. */
  inline: boolean;
  contentId: string;
}

export interface EmlMessage {
  /** No angle brackets. "" when the message carried none. */
  messageId: string;
  inReplyTo: string;
  /** Oldest first, as the header lists them. */
  references: string[];
  subject: string;
  /** Epoch ms, or null when the `Date:` header was missing or unreadable. */
  date: number | null;
  from: EmlAddress[];
  to: EmlAddress[];
  cc: EmlAddress[];
  replyTo: EmlAddress[];
  /** The readable body. Never HTML — see `bodyFromHtml`. */
  body: string;
  /** True when `body` was reduced from `text/html` because there was no plain part. */
  bodyFromHtml: boolean;
  attachments: EmlAttachment[];
  /** True for `multipart/signed` or `multipart/encrypted`. Nothing is verified. */
  signed: boolean;
  encrypted: boolean;
  /**
   * Which file format this came out of.
   *
   * Recorded because the three are not equally trustworthy about identity: an
   * `.eml` carries the real `Message-ID` and `References` chain, while a `.msg`
   * sometimes has neither and has to fall back on a synthesised id. The note
   * says which, so a thread built on synthesised identity is legible as such
   * rather than looking like the real thing.
   *
   * `"outlook"` is a message read out of the live Outlook session (§7 E2). It
   * sits with `.msg` rather than with `.eml`: the same MAPI properties, read
   * through COM instead of out of a compound file, with the same fallbacks
   * when the item never crossed the internet.
   */
  format: "eml" | "msg" | "outlook";
  /** Plain-English notes on anything that could not be read. Never swallowed. */
  problems: string[];
}

/** Types whose payload is a certificate or a signature, not something to keep. */
const CRYPTO_TYPES = new Set([
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-signature",
]);

export function parseEml(bytes: Uint8Array): EmlMessage {
  const problems: string[] = [];
  const root = parsePart(latin1(bytes));
  const headers = root.headers;

  const subject = decodeEncodedWords(headerValue(headers, "subject"), problems).trim();
  const encrypted =
    root.mimeType === "multipart/encrypted" || root.mimeType.startsWith("application/pkcs7-mime");
  const signed = root.mimeType === "multipart/signed";

  if (encrypted) {
    problems.push(
      "This message is encrypted, so only its headers could be read. The body and any attachments stay in Outlook.",
    );
  }
  if (signed) {
    problems.push(
      "This message is signed. The signature was not checked — the text below is what the file contains, not something this plugin has verified.",
    );
  }

  const leaves: MimePart[] = [];
  collectLeaves(root, leaves);

  const bodyPart = chooseBody(leaves);
  const body =
    bodyPart === null ? "" : decodeText(partBytes(bodyPart), bodyPart.charset, problems);

  const message: EmlMessage = {
    messageId: stripAngles(headerValue(headers, "message-id")),
    inReplyTo: stripAngles(headerValue(headers, "in-reply-to")),
    references: parseReferences(headerValue(headers, "references")),
    subject,
    date: parseMailDate(headerValue(headers, "date")),
    from: parseAddressList(headerValue(headers, "from")),
    to: parseAddressList(headerValue(headers, "to")),
    cc: parseAddressList(headerValue(headers, "cc")),
    replyTo: parseAddressList(headerValue(headers, "reply-to")),
    body: bodyPart?.mimeType === "text/html" ? htmlToText(body) : body.replace(/\r\n/g, "\n").trim(),
    bodyFromHtml: bodyPart?.mimeType === "text/html",
    attachments: collectAttachments(leaves, bodyPart),
    signed,
    encrypted,
    format: "eml",
    problems,
  };

  if (message.from.length === 0) {
    problems.push("No readable `From:` address, so which way this message went cannot be told.");
  }
  if (message.date === null) {
    problems.push("No readable `Date:` header.");
  }

  return message;
}

function collectLeaves(part: MimePart, out: MimePart[]): void {
  if (part.parts.length === 0) {
    out.push(part);
    return;
  }
  for (const child of part.parts) collectLeaves(child, out);
}

/**
 * Which part is the message a person would read.
 *
 * `text/plain` wins over `text/html` wherever both exist, which in a
 * `multipart/alternative` is the whole point of the alternative. A part the
 * client marked as an attachment is never the body, even when it is text: an
 * attached `.txt` is a file, not the message.
 */
function chooseBody(leaves: readonly MimePart[]): MimePart | null {
  const candidates = leaves.filter(
    (part) => part.disposition !== "attachment" && part.filename === "",
  );
  return (
    candidates.find((part) => part.mimeType === "text/plain") ??
    candidates.find((part) => part.mimeType === "text/html") ??
    null
  );
}

function collectAttachments(
  leaves: readonly MimePart[],
  bodyPart: MimePart | null,
): EmlAttachment[] {
  const attachments: EmlAttachment[] = [];

  for (const part of leaves) {
    if (part === bodyPart) continue;
    if (part.mimeType.startsWith("multipart/")) continue;
    if (CRYPTO_TYPES.has(part.mimeType)) continue;

    const named = part.filename !== "";
    const declared = part.disposition === "attachment" || part.disposition === "inline";
    // An unnamed, undeclared text part is the other half of an alternative —
    // the HTML twin of the plain body — and is not a file anyone wants saved.
    if (!named && !declared) continue;
    if (!named && part.mimeType.startsWith("text/")) continue;

    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      bytes: partBytes(part),
      // Inline means "referenced from the HTML" — a signature logo, usually.
      inline: part.disposition === "inline" || (part.contentId !== "" && part.disposition === ""),
      contentId: part.contentId,
    });
  }

  return attachments;
}
