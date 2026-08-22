/**
 * The few byte manipulations the backup format needs.
 *
 * Split out so the archive and envelope modules stay about their formats.
 * Hex rather than base64 throughout: `btoa`/`atob` differ subtly between
 * Electron and Node over non-ASCII, and the values here (a 16-byte salt, a
 * 12-byte IV, a digest) are short enough that hex costs nothing and cannot
 * misencode.
 *
 * Pure module: no Obsidian, no Node.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Four bytes, big-endian. Lengths in the container are written this way. */
export function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Length out of range for a 32-bit field: ${value}`);
  }
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new Error("Archive is truncated: a length field runs past the end of the file.");
  }
  // `>>> 0` keeps the result unsigned; a 4 GB archive would otherwise read negative.
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("Archive header holds a value that is not hexadecimal.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Compare two byte strings without an early exit.
 *
 * Only used on digests we computed ourselves, so the timing channel is
 * theoretical — but a length-and-content compare that returns early is the kind
 * of thing that gets copied somewhere it matters.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
