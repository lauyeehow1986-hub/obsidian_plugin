import { describe, expect, it } from "vitest";
import { childNamed, isCompoundFile, readCompoundFile, CfbError } from "./cfb";
import { storage, stream, writeCompoundFile } from "../../../tests/helpers/msgFixture";

const text = (value: string) => new TextEncoder().encode(value);
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("isCompoundFile", () => {
  it("recognises the signature", () => {
    const file = writeCompoundFile(storage("Root Entry", [stream("a", text("x"))]));
    expect(isCompoundFile(file)).toBe(true);
  });

  it("rejects an .eml, which is what it is there to do", () => {
    expect(isCompoundFile(text("From: a@b\r\n\r\nhello".padEnd(600, " ")))).toBe(false);
  });

  it("rejects a file too short to hold a header", () => {
    expect(isCompoundFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
  });
});

describe("readCompoundFile", () => {
  it("reads a short stream out of the mini stream", () => {
    const file = writeCompoundFile(storage("Root Entry", [stream("subject", text("Hello"))]));
    const cfb = readCompoundFile(file);

    expect(cfb.root.children.map((child) => child.name)).toEqual(["subject"]);
    expect(read(childNamed(cfb.root, "subject")!.read())).toBe("Hello");
  });

  it("reads a stream longer than the mini-stream cutoff from full sectors", () => {
    const big = "x".repeat(5000);
    const file = writeCompoundFile(storage("Root Entry", [stream("body", text(big))]));
    const cfb = readCompoundFile(file);

    const entry = childNamed(cfb.root, "body")!;
    expect(entry.size).toBe(5000);
    expect(read(entry.read())).toBe(big);
  });

  it("reads short and long streams from one file", () => {
    const file = writeCompoundFile(
      storage("Root Entry", [
        stream("short", text("tiny")),
        stream("long", text("y".repeat(9000))),
        stream("other", text("also tiny")),
      ]),
    );
    const cfb = readCompoundFile(file);

    expect(read(childNamed(cfb.root, "short")!.read())).toBe("tiny");
    expect(read(childNamed(cfb.root, "other")!.read())).toBe("also tiny");
    expect(childNamed(cfb.root, "long")!.read().length).toBe(9000);
  });

  it("walks nested storages", () => {
    const file = writeCompoundFile(
      storage("Root Entry", [
        stream("top", text("1")),
        storage("__attach_version1.0_#00000000", [
          stream("name", text("scan.pdf")),
          storage("inner", [stream("deep", text("down here"))]),
        ]),
      ]),
    );
    const cfb = readCompoundFile(file);

    const attach = childNamed(cfb.root, "__attach_version1.0_#00000000")!;
    expect(attach.kind).toBe("storage");
    expect(read(childNamed(attach, "name")!.read())).toBe("scan.pdf");

    const inner = childNamed(attach, "inner")!;
    expect(read(childNamed(inner, "deep")!.read())).toBe("down here");
  });

  it("finds every child of a storage with many of them", () => {
    // A red-black tree only branches once there is something to balance, so a
    // wide storage is what actually exercises the left/right walk.
    const names = Array.from({ length: 40 }, (_unused, i) => `s${String(i).padStart(3, "0")}`);
    const file = writeCompoundFile(
      storage("Root Entry", names.map((name) => stream(name, text(name)))),
    );
    const cfb = readCompoundFile(file);

    expect(cfb.root.children).toHaveLength(40);
    expect(cfb.root.children.map((child) => child.name)).toEqual([...names].sort());
    for (const child of cfb.root.children) expect(read(child.read())).toBe(child.name);
  });

  it("returns children in a stable order, because a vault is a record", () => {
    const build = (names: string[]) =>
      readCompoundFile(
        writeCompoundFile(storage("Root Entry", names.map((n) => stream(n, text(n))))),
      ).root.children.map((child) => child.name);

    expect(build(["b", "a", "c"])).toEqual(build(["c", "b", "a"]));
  });

  it("handles an empty stream", () => {
    const file = writeCompoundFile(storage("Root Entry", [stream("empty", new Uint8Array(0))]));
    const entry = childNamed(readCompoundFile(file).root, "empty")!;

    expect(entry.size).toBe(0);
    expect(entry.read()).toHaveLength(0);
  });

  it("preserves arbitrary bytes, not just text", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_unused, i) => i);
    const file = writeCompoundFile(storage("Root Entry", [stream("raw", bytes)]));

    expect([...childNamed(readCompoundFile(file).root, "raw")!.read()]).toEqual([...bytes]);
  });

  it("follows the overflow allocation-table chain a large attachment forces", () => {
    // The header holds 109 FAT sector numbers. With the 512-byte sectors
    // Outlook writes, that runs out at about 7 MB — so any message carrying a
    // sizeable attachment needs the DIFAT chain, and this is not an exotic path.
    const payload = Uint8Array.from({ length: 7_500_000 }, (_unused, i) => i & 0xff);
    const file = writeCompoundFile(storage("Root Entry", [stream("big", payload)]));

    const header = new DataView(file.buffer);
    expect(header.getUint32(44, true)).toBeGreaterThan(109);
    expect(header.getUint32(72, true)).toBeGreaterThan(0);

    const bytes = childNamed(readCompoundFile(file).root, "big")!.read();
    expect(bytes.length).toBe(payload.length);
    expect(bytes[0]).toBe(payload[0]);
    expect(bytes[6_000_000]).toBe(payload[6_000_000]);
    expect(bytes.at(-1)).toBe(payload.at(-1));
  });

  it("refuses a file that is not a compound file", () => {
    expect(() => readCompoundFile(text("hello".padEnd(600, " ")))).toThrow(CfbError);
  });

  it("refuses a declared sector size the format does not define", () => {
    const file = writeCompoundFile(storage("Root Entry", [stream("a", text("x"))]));
    new DataView(file.buffer).setUint16(30, 11, true);

    expect(() => readCompoundFile(file)).toThrow(/sector size/i);
  });

  it("refuses a sector chain that loops rather than reading forever", () => {
    const file = writeCompoundFile(storage("Root Entry", [stream("long", text("z".repeat(9000)))]));

    // Point the first FAT slot at itself. The header's first DIFAT entry says
    // which sector the table starts in, so this does not depend on the
    // fixture's layout.
    const view = new DataView(file.buffer);
    view.setUint32((view.getUint32(76, true) + 1) * 512, 0, true);

    // The file still opens: streams are read on demand, so the damage surfaces
    // when the chain is actually walked, which is the point of the guard.
    const entry = childNamed(readCompoundFile(file).root, "long")!;
    expect(() => entry.read()).toThrow(CfbError);
  });
});
