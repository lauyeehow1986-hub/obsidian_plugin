/**
 * Compressed RTF bodies, as `.msg` files store them (CLAUDE.md §5.10).
 *
 * Two problems, both unavoidable if `.msg` import is to produce readable notes.
 *
 * **One: the body is often only there in RTF.** Outlook stores up to three
 * versions of a message body — plain text, HTML and RTF — and for a good deal
 * of internal mail only the RTF one is populated. Skipping it would mean
 * importing a conversation and finding "(no readable body)" against half the
 * messages, which is worse than not importing it at all.
 *
 * **Two: it is compressed with LZFu** (MS-OXRTFCPR), a small LZ77 variant with
 * one peculiarity: the dictionary starts pre-filled with a fixed 207-byte
 * string of common RTF keywords, so the first few tokens of every message
 * compress against text that was never in the message. That constant has to be
 * byte-exact or the output is plausible-looking rubbish, which is why there is
 * a test asserting its length.
 *
 * ## HTML wrapped in RTF
 *
 * Outlook also stores HTML mail as RTF, with the original markup carried inside
 * `\*\htmltag` destinations and the RTF-only scaffolding fenced off by
 * `\htmlrtf` … `\htmlrtf0` (MS-OXRTFEX). Recovering the HTML and reducing that
 * gives a far better result than treating the RTF as prose, because the RTF
 * scaffolding is full of font tables and paragraph settings nobody wants in a
 * vault note.
 *
 * Nothing here renders, fetches or executes anything: RTF in, plain text out.
 * The result is untrusted text like any other message body (§2 rule 5).
 *
 * Pure module: no Obsidian, no Node.
 */

import { decodeText, latin1 } from "./eml";
import { htmlToText } from "./html";

/** Raised when a stream is not readable as RTF. Always caught by the caller. */
export class RtfError extends Error {}

/**
 * The LZFu dictionary's initial contents (MS-OXRTFCPR §2.1.3.1.2).
 *
 * Exactly 207 bytes, and every byte matters: the compressor encoded the start
 * of the message against this, so a single character out shifts every back
 * reference. The `\r\n` in the middle are real carriage return and line feed.
 */
export const LZFU_DICTIONARY =
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}" +
  "{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans Serif" +
  "SymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n" +
  "\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

const MAGIC_COMPRESSED = 0x75465a4c; // "LZFu"
const MAGIC_UNCOMPRESSED = 0x414c454d; // "MELA"

const DICTIONARY_SIZE = 4096;

/**
 * Undo the LZFu compression on a `PidTagRtfCompressed` stream.
 *
 * The header declares both the compressed and the uncompressed length, and
 * both are honoured as bounds rather than trusted: a declared output size of
 * two gigabytes from a forty-byte stream is the obvious way to turn an importer
 * into a memory exhaustion, and the file came from outside.
 */
export function decompressRtf(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 16) throw new RtfError("Compressed body is too short to hold a header.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSize = view.getUint32(4, true);
  const magic = view.getUint32(8, true);

  if (magic === MAGIC_UNCOMPRESSED) return bytes.subarray(16);
  if (magic !== MAGIC_COMPRESSED) {
    throw new RtfError("Compressed body does not declare a compression this build knows.");
  }

  // A compressed stream cannot expand more than about 17× (a two-byte token
  // yields at most 17 bytes), so anything past that is a malformed header.
  const limit = Math.min(rawSize, bytes.length * 17 + DICTIONARY_SIZE);
  const out = new Uint8Array(limit);

  const dictionary = new Uint8Array(DICTIONARY_SIZE);
  for (let i = 0; i < LZFU_DICTIONARY.length; i++) {
    dictionary[i] = LZFU_DICTIONARY.charCodeAt(i) & 0xff;
  }

  let write = LZFU_DICTIONARY.length;
  let read = 16;
  let length = 0;

  outer: while (read < bytes.length && length < limit) {
    const control = bytes[read++]!;

    for (let bit = 0; bit < 8; bit++) {
      if (read >= bytes.length || length >= limit) break outer;

      if ((control & (1 << bit)) === 0) {
        const byte = bytes[read++]!;
        out[length++] = byte;
        dictionary[write++ % DICTIONARY_SIZE] = byte;
        continue;
      }

      if (read + 1 >= bytes.length) break outer;
      const token = (bytes[read]! << 8) | bytes[read + 1]!;
      read += 2;

      const offset = (token >> 4) & 0x0fff;
      const run = (token & 0x0f) + 2;
      // A back reference to the current write position is the end marker.
      if (offset === write % DICTIONARY_SIZE) break outer;

      for (let i = 0; i < run && length < limit; i++) {
        const byte = dictionary[(offset + i) % DICTIONARY_SIZE]!;
        out[length++] = byte;
        dictionary[write++ % DICTIONARY_SIZE] = byte;
      }
    }
  }

  return out.subarray(0, length);
}

/* ------------------------------------------------------------ reading -- */

export interface RtfBody {
  /** Readable text, never markup. */
  text: string;
  /** True when the RTF was an encapsulated HTML message. */
  fromHtml: boolean;
}

/**
 * Control words whose whole group is scaffolding rather than content.
 *
 * Font and colour tables, style definitions, revision-tracking tables and
 * embedded pictures all sit inside groups that would otherwise be emitted as a
 * wall of keywords. `\*` marks a destination the reader is *supposed* to skip
 * when it does not recognise it, which this honours.
 */
const SKIPPED_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "revtbl", "rsidtbl", "generator", "info", "pict", "object", "themedata",
  "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "filetbl",
  "mmathpr", "wgrffmtfilter", "template", "operator", "userprops", "protusertbl",
  "pgptbl", "panose", "falt", "fname", "atrfstart", "atrfend", "annotation",
  "mhtmltag",
]);

/** Control words that mean a line ending, a tab or a space. */
const BREAKS: Record<string, string> = {
  par: "\n",
  line: "\n",
  sect: "\n",
  page: "\n",
  row: "\n",
  cell: "\t",
  nestcell: "\t",
  tab: "\t",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  endash: "–",
  emdash: "—",
  bullet: "•",
};

interface Group {
  /** Characters still to skip after a `\uN`, per the enclosing `\ucN`. */
  uc: number;
  /** True inside a destination whose content is not message content. */
  skipping: boolean;
}

/**
 * Read decompressed RTF into text.
 *
 * Two modes, chosen by whether the document declares `\fromhtml1`. An
 * encapsulated HTML message is recovered as HTML and then reduced by the same
 * `htmlToText` the `.eml` path uses, so an HTML mail reads identically whether
 * it arrived as `.eml` or `.msg` — which matters, because the same conversation
 * can arrive both ways.
 */
export function readRtf(bytes: Uint8Array, problems: string[]): RtfBody {
  const source = latin1(bytes);
  // The declaration is in the header, before any content; looking only at the
  // start avoids a `\fromhtml1` appearing inside quoted text flipping the mode.
  const fromHtml = /\\fromhtml1(?![0-9])/.test(source.slice(0, 4096));

  const raw = detokenise(source, fromHtml, problems);
  return fromHtml
    ? { text: htmlToText(raw), fromHtml: true }
    : { text: tidyText(raw), fromHtml: false };
}

function detokenise(source: string, fromHtml: boolean, problems: string[]): string {
  const out: string[] = [];
  const stack: Group[] = [];
  let group: Group = { uc: 1, skipping: false };

  // Bytes from `\'hh` escapes, held until something else is emitted so a
  // multi-byte code page decodes as a unit rather than byte by byte.
  let pending: number[] = [];
  let codepage = "windows-1252";
  // In an encapsulated HTML document, `\htmlrtf` fences off spans that exist
  // only for RTF readers and are not part of the HTML.
  let htmlrtf = false;
  // Characters still to swallow after a `\uN`, which is followed by an ASCII
  // approximation the Unicode value replaces.
  let skipChars = 0;

  const flush = () => {
    if (pending.length === 0) return;
    if (!group.skipping && !htmlrtf) {
      out.push(decodeText(Uint8Array.from(pending), codepage, problems));
    }
    pending = [];
  };

  const emit = (text: string) => {
    flush();
    if (!group.skipping && !htmlrtf) out.push(text);
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (char === "{") {
      flush();
      stack.push(group);
      group = { uc: group.uc, skipping: group.skipping };
      continue;
    }

    if (char === "}") {
      flush();
      group = stack.pop() ?? { uc: 1, skipping: false };
      continue;
    }

    if (char !== "\\") {
      if (char === "\r" || char === "\n") continue; // layout, not content
      if (skipChars > 0) {
        skipChars -= 1;
        continue;
      }
      if (!group.skipping && !htmlrtf) pending.push(char.charCodeAt(0));
      continue;
    }

    /* --- a control word or symbol --- */
    const next = source[i + 1];
    if (next === undefined) break;

    if (next === "'") {
      const hex = source.slice(i + 2, i + 4);
      i += 3;
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) continue;
      if (skipChars > 0) {
        skipChars -= 1;
        continue;
      }
      if (!group.skipping && !htmlrtf) pending.push(Number.parseInt(hex, 16));
      continue;
    }

    if (!/[A-Za-z]/.test(next)) {
      i += 1;
      // `\\`, `\{` and `\}` are the escaped literals; `\~` is a hard space.
      if (next === "\\" || next === "{" || next === "}") emit(next);
      else if (next === "~") emit(" ");
      else if (next === "\n" || next === "\r") emit("\n");
      else if (next === "*") {
        // `\*` prefixes a destination the reader should skip when it does not
        // understand it. The word itself is read on the next pass.
        const word = /^\\([A-Za-z]+)/.exec(source.slice(i + 1));
        const name = word?.[1] ?? "";
        if (!(fromHtml && name === "htmltag")) group.skipping = true;
      }
      continue;
    }

    const match = /^([A-Za-z]+)(-?\d+)? ?/.exec(source.slice(i + 1));
    if (match === null) continue;
    const [whole, word, digits] = match;
    i += whole!.length;
    const parameter = digits === undefined ? null : Number(digits);

    flush();

    switch (word) {
      case "ansicpg":
        if (parameter !== null) codepage = `windows-${parameter}`;
        break;
      case "uc":
        if (parameter !== null) group.uc = Math.max(0, parameter);
        break;
      case "u": {
        if (parameter === null) break;
        // Negative values are the signed-16-bit spelling of code points above
        // 0x7FFF, which is how RTF writes anything past the BMP's first half.
        const code = parameter < 0 ? parameter + 0x10000 : parameter;
        if (!group.skipping && !htmlrtf) out.push(String.fromCharCode(code));
        skipChars = group.uc;
        break;
      }
      case "htmlrtf":
        htmlrtf = parameter !== 0;
        break;
      case "htmltag":
        // Its content is literal HTML markup and is emitted as-is.
        group.skipping = false;
        break;
      case "bin":
        // A run of raw bytes follows, which must be stepped over rather than
        // read as control words.
        if (parameter !== null && parameter > 0) i += parameter;
        break;
      default:
        if (SKIPPED_DESTINATIONS.has(word!)) group.skipping = true;
        else if (BREAKS[word!] !== undefined) emit(BREAKS[word!]!);
        break;
    }
  }

  flush();
  return out.join("");
}

/** Collapse the blank-line drifts RTF paragraph markers leave behind. */
function tidyText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
