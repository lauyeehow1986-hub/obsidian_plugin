import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../audit/sha256";
import { checkIntegrity, packArchive, unpackArchive, type ArchiveFile } from "./archive";
import { utf8 } from "./bytes";

const file = (path: string, text: string): ArchiveFile => ({ path, bytes: utf8(text) });
const CREATED = "2026-08-22T06:03:00.000Z";

describe("packArchive", () => {
  it("round-trips paths and bytes exactly", () => {
    const files = [file("10 Requests/REQ-1.md", "---\ntype: scdb-request\n---\nbody"), file("a.md", "")];
    const out = unpackArchive(packArchive("vault", CREATED, files));

    expect(out.manifest.vault).toBe("vault");
    expect(out.manifest.created).toBe(CREATED);
    expect(out.files.map((f) => f.path)).toEqual(["10 Requests/REQ-1.md", "a.md"]);
    expect(new TextDecoder().decode(out.files[0]!.bytes)).toBe(
      "---\ntype: scdb-request\n---\nbody",
    );
    expect(out.files[1]!.bytes).toHaveLength(0);
  });

  it("carries bytes that are not text", () => {
    // Attachments are in scope, so a PDF has to survive the round trip
    // untouched — not decoded, not re-encoded, not normalised.
    const bytes = Uint8Array.from([0, 1, 255, 128, 10, 13, 0]);
    const out = unpackArchive(packArchive("v", CREATED, [{ path: "x.bin", bytes }]));
    expect([...out.files[0]!.bytes]).toEqual([...bytes]);
  });

  it("packs the same vault to the same bytes whatever order it is handed", () => {
    // Deterministic output is what makes two snapshots comparable, and what
    // lets this test assert on bytes rather than on a shape.
    const a = packArchive("v", CREATED, [file("b.md", "two"), file("a.md", "one")]);
    const b = packArchive("v", CREATED, [file("a.md", "one"), file("b.md", "two")]);
    expect([...a]).toEqual([...b]);
  });

  it("records a full digest of every file", () => {
    const bytes = utf8("content");
    const out = unpackArchive(packArchive("v", CREATED, [{ path: "a.md", bytes }]));
    expect(out.manifest.entries[0]?.sha256).toBe(sha256Bytes(bytes));
  });

  it("refuses two entries claiming the same path", () => {
    // Restoring would silently keep whichever came last.
    expect(() => packArchive("v", CREATED, [file("a.md", "one"), file("a.md", "two")])).toThrow(
      /collected twice/,
    );
  });

  it("handles a vault with no files at all", () => {
    const out = unpackArchive(packArchive("v", CREATED, []));
    expect(out.files).toHaveLength(0);
    expect(out.manifest.entries).toHaveLength(0);
  });

  it("survives non-ASCII paths and content", () => {
    const out = unpackArchive(packArchive("v", CREATED, [file("30 People/Zoë.md", "café ☕")]));
    expect(out.files[0]?.path).toBe("30 People/Zoë.md");
    expect(new TextDecoder().decode(out.files[0]!.bytes)).toBe("café ☕");
  });
});

describe("unpackArchive", () => {
  const packed = () => packArchive("v", CREATED, [file("a.md", "one"), file("b.md", "two")]);

  it("reports a truncated file rather than returning half of one", () => {
    const cut = packed().subarray(0, packed().length - 2);
    expect(() => unpackArchive(cut)).toThrow(/truncated/);
  });

  it("reports trailing bytes the manifest does not account for", () => {
    const grown = new Uint8Array(packed().length + 4);
    grown.set(packed());
    expect(() => unpackArchive(grown)).toThrow(/unaccounted/);
  });

  it("refuses an unreadable manifest instead of guessing", () => {
    const broken = packed();
    // Corrupt the first byte of the manifest JSON, past the length field.
    broken[4] = 0x21;
    expect(() => unpackArchive(broken)).toThrow(/damaged/);
  });
});

describe("checkIntegrity", () => {
  it("passes a clean archive", () => {
    expect(checkIntegrity(unpackArchive(packArchive("v", CREATED, [file("a.md", "x")])))).toEqual(
      [],
    );
  });

  it("names a file whose bytes no longer match its recorded digest", () => {
    // The case the manifest digests exist for: damage introduced *before*
    // sealing, which authentication would happily seal in.
    const archive = unpackArchive(packArchive("v", CREATED, [file("a.md", "x")]));
    archive.files[0] = { path: "a.md", bytes: utf8("y") };
    const faults = checkIntegrity(archive);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.path).toBe("a.md");
  });
});
