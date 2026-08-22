/**
 * The encryption envelope around an archive (CLAUDE.md §7 A4).
 *
 * AES-256-GCM, key derived from a passphrase with scrypt. The passphrase is
 * never stored, never cached and never written anywhere: losing it means losing
 * the archive, and the UI says so in those words.
 *
 * File layout:
 *
 *     "SCDBBAK1\n"      magic, so a wrong file is refused by name not by crash
 *     u32               header length
 *     ...               header, UTF-8 JSON, PLAINTEXT and authenticated
 *     ...               ciphertext
 *     16 bytes          GCM authentication tag
 *
 * The header is deliberately readable without the passphrase. `Verify backup`
 * can then say "this is a snapshot of 412 files taken on 20 August" before
 * asking for anything, and a future build can recognise an older format rather
 * than reporting a corrupt file. It is authenticated as GCM additional data, so
 * editing it — swapping the salt, lying about the date — fails the tag.
 *
 * What the header must NOT carry is anything identifying the vault: no paths,
 * no note names, no vault name. Those live inside the encryption (`Manifest`),
 * because the file sits in an ordinary folder on a laptop.
 *
 * Pure module: no Obsidian, no Node. The primitives arrive as a `CryptoBox` so
 * this format is unit-testable, with the real Node implementation injected in
 * `tests/backup.test.ts`.
 */

import { concatBytes, fromHex, fromUtf8, readU32be, toHex, u32be, utf8 } from "./bytes";

export const MAGIC = "SCDBBAK1\n";
export const ENVELOPE_FORMAT = 1;
export const TAG_BYTES = 16;
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

/**
 * scrypt cost. N=32768, r=8 needs 128·N·r = 32 MiB and about a fifth of a
 * second — comfortably above the interactive default, and the archive is
 * written once a week, not once a keystroke. The parameters are recorded in
 * the header so raising them later still reads every old snapshot.
 */
export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_KDF: KdfParams = { name: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 };

export interface EnvelopeHeader {
  format: number;
  /** ISO 8601 UTC. */
  created: string;
  /** Plugin version that wrote it, so a restore can say what made the file. */
  plugin: string;
  kdf: KdfParams & { salt: string };
  cipher: { name: "aes-256-gcm"; iv: string };
  compression: "gzip";
  /** Counts only — never names (rule 7). */
  files: number;
  /** Size of the uncompressed container, for a sanity check on restore. */
  bytes: number;
}

/** The primitives, injected. Implemented over `node:crypto` and `node:zlib`. */
export interface CryptoBox {
  randomBytes(count: number): Uint8Array;
  scrypt(passphrase: string, salt: Uint8Array, params: KdfParams): Uint8Array;
  encrypt(input: {
    key: Uint8Array;
    iv: Uint8Array;
    aad: Uint8Array;
    plaintext: Uint8Array;
  }): { ciphertext: Uint8Array; tag: Uint8Array };
  /** Throws when the tag does not authenticate. Never returns partial output. */
  decrypt(input: {
    key: Uint8Array;
    iv: Uint8Array;
    aad: Uint8Array;
    ciphertext: Uint8Array;
    tag: Uint8Array;
  }): Uint8Array;
  gzip(bytes: Uint8Array): Uint8Array;
  gunzip(bytes: Uint8Array): Uint8Array;
}

export interface SealInput {
  container: Uint8Array;
  passphrase: string;
  created: string;
  plugin: string;
  files: number;
}

export function seal(input: SealInput, box: CryptoBox): Uint8Array {
  if (input.passphrase === "") {
    throw new Error("A snapshot needs a passphrase. Without one there is nothing protecting it.");
  }

  const salt = box.randomBytes(SALT_BYTES);
  const iv = box.randomBytes(IV_BYTES);
  const key = box.scrypt(input.passphrase, salt, DEFAULT_KDF);

  const header: EnvelopeHeader = {
    format: ENVELOPE_FORMAT,
    created: input.created,
    plugin: input.plugin,
    kdf: { ...DEFAULT_KDF, salt: toHex(salt) },
    cipher: { name: "aes-256-gcm", iv: toHex(iv) },
    compression: "gzip",
    files: input.files,
    bytes: input.container.length,
  };
  const headerBytes = utf8(JSON.stringify(header));

  const sealed = box.encrypt({
    key,
    iv,
    // The header authenticates as additional data: it is not secret, but it
    // must not be editable either.
    aad: headerBytes,
    plaintext: box.gzip(input.container),
  });

  return concatBytes([
    utf8(MAGIC),
    u32be(headerBytes.length),
    headerBytes,
    sealed.ciphertext,
    sealed.tag,
  ]);
}

interface Split {
  header: EnvelopeHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

function isHeader(value: unknown): value is EnvelopeHeader {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  const kdf = h["kdf"];
  const cipher = h["cipher"];
  if (typeof kdf !== "object" || kdf === null) return false;
  if (typeof cipher !== "object" || cipher === null) return false;
  return (
    typeof h["format"] === "number" &&
    typeof h["bytes"] === "number" &&
    typeof (kdf as Record<string, unknown>)["salt"] === "string" &&
    typeof (cipher as Record<string, unknown>)["iv"] === "string"
  );
}

function split(bytes: Uint8Array): Split {
  const magic = utf8(MAGIC);
  if (bytes.length < magic.length || fromUtf8(bytes.subarray(0, magic.length)) !== MAGIC) {
    throw new Error(
      "This is not an SCDB Cockpit snapshot — it does not start with the right marker.",
    );
  }

  const headerLength = readU32be(bytes, magic.length);
  const headerStart = magic.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd + TAG_BYTES > bytes.length) {
    throw new Error("Snapshot is truncated: it ends inside its own header.");
  }

  const headerBytes = bytes.subarray(headerStart, headerEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(headerBytes));
  } catch {
    throw new Error("Snapshot header is not readable JSON. The file is damaged.");
  }
  if (!isHeader(parsed)) {
    throw new Error("Snapshot header is missing fields this build needs. The file is damaged.");
  }
  if (parsed.format !== ENVELOPE_FORMAT) {
    throw new Error(
      `Snapshot is format ${String(parsed.format)}; this build reads format ${ENVELOPE_FORMAT}. Use the version of the plugin that wrote it.`,
    );
  }

  return {
    header: parsed,
    headerBytes,
    ciphertext: bytes.subarray(headerEnd, bytes.length - TAG_BYTES),
    tag: bytes.subarray(bytes.length - TAG_BYTES),
  };
}

/** Read the header alone. No passphrase, no decryption, no authentication. */
export function readHeader(bytes: Uint8Array): EnvelopeHeader {
  return split(bytes).header;
}

/**
 * Decrypt back to the container.
 *
 * A wrong passphrase and a damaged file both surface as a failed tag, and GCM
 * genuinely cannot tell them apart. The message says so rather than asserting
 * one — telling someone their file is corrupt when they mistyped is how a
 * usable backup gets thrown away.
 */
export function open(bytes: Uint8Array, passphrase: string, box: CryptoBox): Uint8Array {
  const parts = split(bytes);
  const key = box.scrypt(passphrase, fromHex(parts.header.kdf.salt), {
    ...DEFAULT_KDF,
    ...parts.header.kdf,
  });

  let plaintext: Uint8Array;
  try {
    plaintext = box.decrypt({
      key,
      iv: fromHex(parts.header.cipher.iv),
      aad: parts.headerBytes,
      ciphertext: parts.ciphertext,
      tag: parts.tag,
    });
  } catch {
    throw new Error(
      "Could not open the snapshot: either the passphrase is wrong or the file has been altered. Encryption cannot tell those apart, so check the passphrase first.",
    );
  }

  const container = box.gunzip(plaintext);
  if (container.length !== parts.header.bytes) {
    throw new Error(
      `Snapshot decompressed to ${container.length} bytes but its header says ${parts.header.bytes}. The file is damaged.`,
    );
  }
  return container;
}
