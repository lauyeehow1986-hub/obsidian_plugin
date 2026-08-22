/**
 * The archive container (CLAUDE.md §7 A4) — what goes inside the encryption.
 *
 * A deliberately small format of our own rather than a zip. Two reasons, and
 * the first is the honest one:
 *
 *  1. A zip writer is a dependency. `fflate` is ~8 KB and would have to be
 *     asked for and carried in a bundle with a 1.5 MB ceiling (§3). This
 *     container is about sixty lines and needs nothing.
 *  2. The usual argument for zip — "any tool can open it" — does not apply.
 *     The archive is AES-256-GCM sealed, so nothing opens it without this
 *     plugin and the passphrase either way. Compression comes from Node's
 *     built-in gzip over the whole container, which beats per-file deflate on a
 *     vault of small markdown files anyway.
 *
 * Layout, all lengths big-endian:
 *
 *     u32  manifest length
 *     ...  manifest, UTF-8 JSON
 *     ...  file bodies, concatenated in manifest order, no delimiters
 *
 * Entries are sorted by path, so the same vault packs to the same bytes. That
 * makes the round-trip testable and means a diff between two snapshots means
 * something.
 *
 * Pure module: no Obsidian, no Node.
 */

import { sha256Bytes } from "../audit/sha256";
import { concatBytes, fromUtf8, readU32be, u32be, utf8 } from "./bytes";

export const ARCHIVE_FORMAT = 1;

export interface ArchiveFile {
  /** Vault-relative path, forward slashes, exactly as Obsidian reports it. */
  path: string;
  bytes: Uint8Array;
}

export interface ManifestEntry {
  path: string;
  size: number;
  /** Full 64-character digest. This is an integrity check, not a table cell. */
  sha256: string;
}

export interface Manifest {
  format: number;
  /** The vault folder's name. Inside the encryption, never in the header. */
  vault: string;
  /** ISO 8601 UTC. The archive travels; a local time with no offset would not. */
  created: string;
  entries: ManifestEntry[];
}

export function packArchive(
  vault: string,
  createdIso: string,
  files: readonly ArchiveFile[],
): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const duplicate = sorted.find((file, i) => i > 0 && sorted[i - 1]!.path === file.path);
  if (duplicate !== undefined) {
    // Two entries for one path would restore whichever came last, silently.
    throw new Error(`The same file was collected twice: ${duplicate.path}`);
  }

  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    vault,
    created: createdIso,
    entries: sorted.map((file) => ({
      path: file.path,
      size: file.bytes.length,
      sha256: sha256Bytes(file.bytes),
    })),
  };

  const manifestBytes = utf8(JSON.stringify(manifest));
  return concatBytes([u32be(manifestBytes.length), manifestBytes, ...sorted.map((f) => f.bytes)]);
}

export interface UnpackedArchive {
  manifest: Manifest;
  files: ArchiveFile[];
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (!Array.isArray(m["entries"])) return false;
  return m["entries"].every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)["path"] === "string" &&
      typeof (entry as Record<string, unknown>)["size"] === "number",
  );
}

export function unpackArchive(container: Uint8Array): UnpackedArchive {
  const manifestLength = readU32be(container, 0);
  const manifestEnd = 4 + manifestLength;
  if (manifestEnd > container.length) {
    throw new Error("Archive is truncated: the manifest runs past the end of the file.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(container.subarray(4, manifestEnd)));
  } catch {
    throw new Error("Archive manifest is not readable JSON. The file is damaged.");
  }
  if (!isManifest(parsed)) {
    throw new Error("Archive manifest has no file list. The file is damaged.");
  }
  const manifest: Manifest = parsed;
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(
      `Archive is format ${String(manifest.format)}; this build reads format ${ARCHIVE_FORMAT}.`,
    );
  }

  const files: ArchiveFile[] = [];
  let at = manifestEnd;
  for (const entry of manifest.entries) {
    const end = at + entry.size;
    if (end > container.length) {
      throw new Error(`Archive is truncated: "${entry.path}" runs past the end of the file.`);
    }
    files.push({ path: entry.path, bytes: container.subarray(at, end) });
    at = end;
  }
  if (at !== container.length) {
    throw new Error(
      `Archive has ${container.length - at} unaccounted bytes after the last file. The file is damaged.`,
    );
  }

  return { manifest, files };
}

export interface IntegrityFault {
  path: string;
  expected: string;
  found: string;
}

/**
 * Re-hash every file against the manifest.
 *
 * GCM already proves the archive as a whole has not been altered, so this
 * cannot fail on a file that decrypted cleanly. It is here for the case that
 * matters more: a fault introduced *before* the archive was sealed — a truncated
 * read off a syncing drive — which authentication would happily seal in.
 */
export function checkIntegrity(archive: UnpackedArchive): IntegrityFault[] {
  const faults: IntegrityFault[] = [];
  archive.manifest.entries.forEach((entry, index) => {
    const file = archive.files[index];
    if (file === undefined) return;
    const found = sha256Bytes(file.bytes);
    if (found !== entry.sha256) faults.push({ path: entry.path, expected: entry.sha256, found });
  });
  return faults;
}
