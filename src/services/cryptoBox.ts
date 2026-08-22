/**
 * The `CryptoBox` the backup envelope needs, over Node's built-ins.
 *
 * `node:crypto` and `node:zlib` are available in Electron and are marked
 * external in the esbuild config, so nothing here reaches the bundle — which is
 * the whole reason A4 specifies them (CLAUDE.md §7 A4: "no native modules").
 * The manifest already declares `isDesktopOnly: true`.
 *
 * Kept separate from `services/backup.ts` so the format can be exercised
 * against the real primitives in a Vitest run without touching a vault or a
 * disk (`tests/backup.test.ts`).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CryptoBox, KdfParams } from "../domain/backup/envelope";

/**
 * `Buffer` is a `Uint8Array`, but a *view* into a shared pool for small
 * allocations. Handing that straight back would give callers a window onto
 * memory they did not ask for and, worse, one whose `.buffer` is not theirs.
 * Copy on the way out.
 */
function copy(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
}

export function nodeCryptoBox(): CryptoBox {
  return {
    randomBytes: (count) => copy(randomBytes(count)),

    scrypt: (passphrase, salt, params: KdfParams) =>
      copy(
        scryptSync(passphrase.normalize("NFC"), Buffer.from(salt), params.keyLength, {
          N: params.N,
          r: params.r,
          p: params.p,
          // Node caps scrypt memory at 32 MiB by default, which is exactly what
          // N=32768, r=8 needs — so the default rejects our own parameters.
          // Doubling the ceiling leaves room to raise the cost later.
          maxmem: 64 * 1024 * 1024,
        }),
      ),

    encrypt: ({ key, iv, aad, plaintext }) => {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      return { ciphertext: copy(ciphertext), tag: copy(cipher.getAuthTag()) };
    },

    decrypt: ({ key, iv, aad, ciphertext, tag }) => {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tag));
      // `final()` is what throws on a bad tag. Node buffers the whole message,
      // so nothing unauthenticated has been handed back before this point.
      return copy(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
    },

    gzip: (bytes) => copy(gzipSync(Buffer.from(bytes), { level: 9 })),
    gunzip: (bytes) => copy(gunzipSync(Buffer.from(bytes))),
  };
}

/**
 * The passphrase normalisation the box applies, exposed so the UI can warn.
 *
 * A passphrase typed with an accented character can be composed two different
 * ways that look identical; NFC on both sides means the same keystrokes always
 * derive the same key, whatever the keyboard did.
 */
export function normalisePassphrase(value: string): string {
  return value.normalize("NFC");
}
