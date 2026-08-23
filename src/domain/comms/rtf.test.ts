import { describe, expect, it } from "vitest";
import { decompressRtf, readRtf, RtfError, LZFU_DICTIONARY } from "./rtf";

/** One literal byte, or a back reference into the sliding dictionary. */
type Op = string | { at: number; run: number };

/**
 * Hand-assemble an LZFu stream.
 *
 * Deliberately not a compressor. A round trip through a compressor written by
 * the same hand would pass just as happily if both ends misunderstood the
 * format; these streams are laid out byte by byte from the specification, so
 * they test the decompressor against the format rather than against itself.
 */
function lzfu(ops: readonly Op[], magic = "LZFu", rawSizeOverride?: number): Uint8Array {
  const body: number[] = [];
  let rawSize = 0;

  if (magic === "MELA") {
    // An uncompressed stream is raw bytes after the header: no control bytes,
    // no tokens. Getting this wrong in the fixture masked nothing, but it made
    // the test assert something the format never produces.
    for (const op of ops) {
      if (typeof op !== "string") throw new Error("an uncompressed stream cannot hold references");
      body.push(op.charCodeAt(0) & 0xff);
      rawSize += 1;
    }
  }

  for (let i = 0; magic !== "MELA" && i < ops.length; i += 8) {
    const batch = ops.slice(i, i + 8);
    let control = 0;
    batch.forEach((op, bit) => {
      if (typeof op !== "string") control |= 1 << bit;
    });

    const chunk: number[] = [];
    for (const op of batch) {
      if (typeof op === "string") {
        chunk.push(op.charCodeAt(0) & 0xff);
        rawSize += 1;
      } else {
        const token = ((op.at & 0x0fff) << 4) | ((op.run - 2) & 0x0f);
        chunk.push((token >> 8) & 0xff, token & 0xff);
        rawSize += op.run;
      }
    }
    body.push(control, ...chunk);
  }

  const out = new Uint8Array(16 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length - 4, true);
  view.setUint32(4, rawSizeOverride ?? rawSize, true);
  view.setUint32(8, [...magic].reduce((n, c, i) => n | (c.charCodeAt(0) << (i * 8)), 0) >>> 0, true);
  view.setUint32(12, 0, true);
  out.set(body, 16);
  return out;
}

const literals = (text: string): Op[] => [...text];
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const rtf = (source: string) => readRtf(new TextEncoder().encode(source), []);

describe("LZFU_DICTIONARY", () => {
  it("is exactly 207 bytes", () => {
    // Every byte shifts every back reference in every message. This is the
    // single constant in the module that cannot be got slightly wrong.
    expect(LZFU_DICTIONARY).toHaveLength(207);
  });

  it("starts and ends where the specification says", () => {
    expect(LZFU_DICTIONARY.startsWith("{\\rtf1\\ansi\\mac\\deff0\\deftab720")).toBe(true);
    expect(LZFU_DICTIONARY.endsWith("\\b\\i\\u\\tab\\tx")).toBe(true);
    expect(LZFU_DICTIONARY).toContain("MS Sans SerifSymbolArialTimes New RomanCourier");
  });
});

describe("decompressRtf", () => {
  it("reads a stream of literal bytes", () => {
    expect(read(decompressRtf(lzfu(literals("{\\rtf1 hi}"))))).toBe("{\\rtf1 hi}");
  });

  it("resolves a back reference into the pre-filled dictionary", () => {
    // Offset 0, six bytes: the dictionary's own opening, which never appeared
    // in the compressed stream. This is the behaviour that makes LZFu unlike
    // ordinary LZ77, and the one most easily got wrong.
    expect(read(decompressRtf(lzfu([{ at: 0, run: 6 }])))).toBe("{\\rtf1");
  });

  it("resolves a back reference to text earlier in the same message", () => {
    // "abcd" is written at dictionary offsets 207..210 as it is emitted.
    const ops: Op[] = [...literals("abcd"), { at: 207, run: 4 }];
    expect(read(decompressRtf(lzfu(ops)))).toBe("abcdabcd");
  });

  it("mixes literals and references across control-byte boundaries", () => {
    const ops: Op[] = [...literals("0123456789"), { at: 0, run: 6 }, ...literals("!")];
    expect(read(decompressRtf(lzfu(ops)))).toBe("0123456789{\\rtf1!");
  });

  it("passes an uncompressed stream through untouched", () => {
    expect(read(decompressRtf(lzfu(literals("{\\rtf1 plain}"), "MELA")))).toBe(
      "{\\rtf1 plain}",
    );
  });

  it("refuses a stream too short to hold a header", () => {
    expect(() => decompressRtf(new Uint8Array(8))).toThrow(RtfError);
  });

  it("refuses a compression it does not know", () => {
    expect(() => decompressRtf(lzfu(literals("x"), "ZZZZ"))).toThrow(RtfError);
  });

  it("bounds the output when the header overstates the raw size", () => {
    // A forty-byte stream claiming to expand to a gigabyte is the obvious way
    // to turn an import into memory exhaustion.
    const bytes = decompressRtf(lzfu(literals("short"), "LZFu", 1_000_000_000));
    expect(bytes.length).toBe(5);
  });

  it("stops at the end marker rather than running past it", () => {
    // A reference whose offset equals the current write position ends the
    // stream; anything after it is padding.
    const ops: Op[] = [...literals("done"), { at: 211, run: 2 }, ...literals("XXXX")];
    expect(read(decompressRtf(lzfu(ops, "LZFu", 9999)))).toBe("done");
  });
});

describe("readRtf — plain RTF", () => {
  it("reads paragraphs and tabs", () => {
    expect(rtf("{\\rtf1\\ansi Line one\\par Line two\\tab indented}").text).toBe(
      "Line one\nLine two\tindented",
    );
  });

  it("drops the font and colour tables", () => {
    const source =
      "{\\rtf1\\ansi{\\fonttbl{\\f0\\fswiss Arial;}}{\\colortbl;\\red0\\green0\\blue0;}Actual text}";
    expect(rtf(source).text).toBe("Actual text");
  });

  it("drops an unknown ignorable destination", () => {
    expect(rtf("{\\rtf1{\\*\\somethingnew hidden}kept}").text).toBe("kept");
  });

  it("decodes a code-page escape as windows-1252, matching the .eml path", () => {
    // 0x92 is a right single quote in the WHATWG mapping — see eml.ts on why
    // this cannot be left to the platform's own decoder.
    expect(rtf("{\\rtf1\\ansi\\ansicpg1252 don\\'92t}").text).toBe("don’t");
  });

  it("decodes an escaped pound sign", () => {
    expect(rtf("{\\rtf1\\ansi\\ansicpg1252 \\'a3200}").text).toBe("£200");
  });

  it("reads a Unicode escape and swallows its ASCII stand-in", () => {
    expect(rtf("{\\rtf1\\ansi\\uc1 caf\\u233 ?}").text).toBe("café");
  });

  it("honours a wider \\uc skip count", () => {
    expect(rtf("{\\rtf1\\ansi\\uc3 x\\u8212 ---y}").text).toBe("x—y");
  });

  it("reads the named dash and quote control words", () => {
    expect(rtf("{\\rtf1 a\\emdash b\\rquote s}").text).toBe("a—b’s");
  });

  it("keeps escaped braces and backslashes as literals", () => {
    expect(rtf("{\\rtf1 a\\{b\\}c\\\\d}").text).toBe("a{b}c\\d");
  });

  it("steps over a binary run rather than reading it as markup", () => {
    expect(rtf("{\\rtf1 before\\bin5 ABCDE after}").text).toBe("before after");
  });

  it("counts a binary run in bytes, even when those bytes look like markup", () => {
    // The five bytes after the delimiter are a backslash, p, a, r, backslash.
    // Read as control words they would insert a line break that is not in the
    // document, so the count has to win over what the bytes happen to spell.
    expect(rtf("{\\rtf1 before\\bin5 \\par\\x after}").text).toBe("beforex after");
  });

  it("treats the single space after a control word as its delimiter, not content", () => {
    // `\emdash text` is a dash immediately followed by text — the space belongs
    // to the keyword. A real space needs a second one, which is why the
    // encapsulated-HTML fixture below has two.
    expect(rtf("{\\rtf1 a\\emdash b}").text).toBe("a—b");
    expect(rtf("{\\rtf1 a\\emdash  b}").text).toBe("a— b");
  });

  it("collapses the blank lines paragraph markers leave behind", () => {
    expect(rtf("{\\rtf1 one\\par\\par\\par\\par two}").text).toBe("one\n\ntwo");
  });

  it("reports no text for an empty document rather than throwing", () => {
    expect(rtf("{\\rtf1\\ansi}").text).toBe("");
  });
});

describe("readRtf — HTML encapsulated in RTF", () => {
  const encapsulated = [
    "{\\rtf1\\ansi\\fromhtml1\\deff0",
    "{\\fonttbl{\\f0\\fswiss Arial;}}",
    "{\\*\\htmltag148 <p>}",
    // Two spaces: the first delimits the control word, the second is content.
    "Approved \\endash  please proceed.",
    "{\\*\\htmltag156 </p>}",
    "\\htmlrtf \\par \\htmlrtf0",
    "{\\*\\htmltag148 <p>}",
    "Second paragraph.",
    "{\\*\\htmltag156 </p>}",
    "}",
  ].join("");

  it("recovers the HTML and reduces it the same way the .eml path does", () => {
    const body = rtf(encapsulated);
    expect(body.fromHtml).toBe(true);
    expect(body.text).toBe("Approved – please proceed.\n\nSecond paragraph.");
  });

  it("ignores the RTF-only spans fenced by \\htmlrtf", () => {
    // The fenced `\par` exists for RTF readers; emitting it would double every
    // line break in the message.
    expect(rtf(encapsulated).text).not.toContain("\n\n\n");
  });

  it("does not treat a \\fromhtml1 buried in the body as a declaration", () => {
    const source = `{\\rtf1\\ansi ${"padding ".repeat(700)}\\fromhtml1 tail}`;
    expect(rtf(source).fromHtml).toBe(false);
  });

  it("leaves plain RTF marked as not from HTML", () => {
    expect(rtf("{\\rtf1\\ansi hello}").fromHtml).toBe(false);
  });
});
