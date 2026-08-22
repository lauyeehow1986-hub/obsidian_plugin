/**
 * The backup format against the real primitives (CLAUDE.md §7 A4, §9).
 *
 * `domain/backup` takes its crypto as an injected `CryptoBox` so it stays pure.
 * That would be worth nothing if the only box it were ever tested against were
 * a fake, so this file injects the production one — Node's `crypto` and `zlib`,
 * the same code Electron runs — and drives a whole snapshot through it.
 *
 * These are slow by design: scrypt at N=32768 is the point, not an accident.
 */

import { describe, expect, it } from "vitest";
import { packArchive, unpackArchive, type ArchiveFile } from "../src/domain/backup/archive";
import { utf8 } from "../src/domain/backup/bytes";
import { MAGIC, open, readHeader, seal } from "../src/domain/backup/envelope";
import { planRestore } from "../src/domain/backup/restore";
import { nodeCryptoBox } from "../src/services/cryptoBox";

const box = nodeCryptoBox();
const CREATED = "2026-08-22T06:03:00.000Z";
const PASSPHRASE = "correct horse battery staple";

const vault: ArchiveFile[] = [
  { path: "10 Requests/REQ-2026-014.md", bytes: utf8("---\ntype: scdb-request\n---\nnarrative") },
  { path: "82 Audit/2026-08.md", bytes: utf8("| ts | actor |\n") },
  { path: "attachments/scan.bin", bytes: Uint8Array.from([0, 255, 13, 10, 0, 127]) },
];

function snapshot(passphrase = PASSPHRASE): Uint8Array {
  return seal(
    { container: packArchive("Vault", CREATED, vault), passphrase, created: CREATED, plugin: "0.1.0", files: vault.length },
    box,
  );
}

describe("a sealed snapshot", () => {
  it("survives seal, open, unpack and plan", () => {
    const archive = unpackArchive(open(snapshot(), PASSPHRASE, box));

    expect(archive.manifest.vault).toBe("Vault");
    expect(archive.files.map((f) => f.path)).toEqual([
      "10 Requests/REQ-2026-014.md",
      "82 Audit/2026-08.md",
      "attachments/scan.bin",
    ]);
    expect([...archive.files[2]!.bytes]).toEqual([0, 255, 13, 10, 0, 127]);

    // Into an empty vault, everything comes back.
    const plan = planRestore(archive.files, new Set());
    expect(plan.create).toHaveLength(3);
    expect(plan.refused).toHaveLength(0);
  });

  it("starts with the magic marker and carries no vault content in the clear", () => {
    const bytes = snapshot();
    expect(new TextDecoder().decode(bytes.subarray(0, MAGIC.length))).toBe(MAGIC);

    // The file sits in a folder like Downloads. Nothing about what is inside
    // the vault may be readable without the passphrase — not a note path, not
    // the vault's own name.
    const asText = Buffer.from(bytes).toString("latin1");
    expect(asText).not.toContain("REQ-2026-014");
    expect(asText).not.toContain("narrative");
    expect(asText).not.toContain("Vault");
  });

  it("reads its header without a passphrase", () => {
    const header = readHeader(snapshot());
    expect(header.files).toBe(3);
    expect(header.created).toBe(CREATED);
    expect(header.plugin).toBe("0.1.0");
    expect(header.kdf.N).toBe(32768);
    expect(header.cipher.name).toBe("aes-256-gcm");
  });

  it("uses a fresh salt and IV every time", () => {
    // Reusing a GCM IV under one key is the classic way to lose a stream
    // cipher's security outright.
    const a = readHeader(snapshot());
    const b = readHeader(snapshot());
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
  });

  it("refuses to be written without a passphrase", () => {
    expect(() => snapshot("")).toThrow(/needs a passphrase/);
  });
});

describe("a snapshot that cannot be trusted", () => {
  it("refuses a wrong passphrase, and says it might be the passphrase", () => {
    // GCM cannot distinguish a wrong key from a damaged file. Telling someone
    // their only backup is corrupt when they mistyped is how it gets deleted.
    expect(() => open(snapshot(), "not the passphrase", box)).toThrow(/passphrase is wrong/);
  });

  it("refuses a file that is not one of ours", () => {
    expect(() => readHeader(utf8("PK a zip file"))).toThrow(/not an SCDB Cockpit/);
  });

  it("detects a flipped bit in the ciphertext", () => {
    const bytes = snapshot();
    const at = bytes.length - 40;
    bytes[at] = bytes[at]! ^ 0x01;
    expect(() => open(bytes, PASSPHRASE, box)).toThrow(/altered/);
  });

  it("detects an edited header, even though the header is plaintext", () => {
    // The header is authenticated as GCM additional data precisely so that
    // "readable" does not become "editable".
    const bytes = snapshot();
    const text = Buffer.from(bytes).toString("latin1");
    const at = text.indexOf('"plugin":"0.1.0"');
    expect(at).toBeGreaterThan(0);
    bytes[at + '"plugin":"0.1.'.length] = "9".charCodeAt(0);

    expect(readHeader(bytes).plugin).toBe("0.1.9");
    expect(() => open(bytes, PASSPHRASE, box)).toThrow(/altered/);
  });

  it("detects a truncated file", () => {
    expect(() => open(snapshot().subarray(0, 200), PASSPHRASE, box)).toThrow();
  });
});

describe("compression", () => {
  it("is worth having on a vault of markdown", () => {
    // Not an assertion about a ratio, just that gzip is actually applied: a
    // snapshot of highly repetitive notes must come out far smaller than the
    // sum of its parts, or the pipeline has quietly stopped compressing.
    const repetitive: ArchiveFile[] = Array.from({ length: 40 }, (_, i) => ({
      path: `10 Requests/REQ-${i}.md`,
      bytes: utf8("---\ntype: scdb-request\nstage: triage\n---\n".repeat(30)),
    }));
    const container = packArchive("V", CREATED, repetitive);
    const sealed = seal(
      { container, passphrase: PASSPHRASE, created: CREATED, plugin: "0.1.0", files: 40 },
      box,
    );
    expect(sealed.length).toBeLessThan(container.length / 4);
  });
});
