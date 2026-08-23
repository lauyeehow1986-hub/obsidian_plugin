/**
 * Compound File Binary reader — the container `.msg` files are written in
 * (MS-CFB), for CLAUDE.md §5.10 email Tier 1.
 *
 * A `.msg` is not a message in any textual sense. It is a **filesystem in a
 * file**: sectors, a file allocation table, and a directory of named storages
 * and streams, all little-endian. The same format carries legacy `.doc`, `.xls`
 * and `.msi`. This module knows nothing about mail — it turns bytes into a tree
 * of named streams and stops there. `msg.ts` reads meaning into that tree.
 *
 * Splitting it this way is not decoration. The container layer is testable
 * against any compound file in the world, including ones nobody here wrote,
 * which is the only way to be sure the sector arithmetic is right.
 *
 * ## What the format actually is
 *
 * The file is divided into sectors of 512 bytes (major version 3) or 4096
 * (version 4), numbered from 0 **after** the 512-byte header — so sector `n`
 * begins at `(n + 1) * sectorSize`. A stream is a linked list of sectors, and
 * the links live in the FAT: `fat[n]` is the sector after `n`, or a sentinel.
 * Streams smaller than 4096 bytes are packed into a single "mini stream" and
 * chained through a second, 64-byte-granular table, because a 30-byte subject
 * would otherwise cost a whole sector — and a message has dozens of those.
 *
 * The directory is itself a stream of 128-byte entries holding a red-black
 * tree per storage. The colouring is irrelevant to reading; only the left,
 * right and child pointers matter.
 *
 * ## Hostile input is the normal case
 *
 * This parses a binary file that arrived by email. Every chain walk is bounded,
 * every offset is checked against the file length, and a malformed file raises
 * `CfbError` rather than looping or reading past the end. An importer that
 * hangs Obsidian on one bad attachment is worse than one that skips it.
 *
 * Pure module: no Obsidian, no Node.
 */

/** Raised for a file that is not a readable compound file. Always caught. */
export class CfbError extends Error {}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Sector chain sentinels (MS-CFB §2.2). Anything ≥ MAX_REGULAR ends a walk. */
const MAX_REGULAR = 0xfffffffa;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

const DIRECTORY_ENTRY_SIZE = 128;
const NO_STREAM = 0xffffffff;

/** Object types in a directory entry (MS-CFB §2.6.1). */
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export interface CfbEntry {
  /** The entry's own name, as written. Not a path. */
  name: string;
  kind: "storage" | "stream";
  /** Storages only. Streams always have none. */
  children: CfbEntry[];
  /** Declared length in bytes. Streams only; 0 for a storage. */
  size: number;
  /**
   * The stream's bytes, decoded on demand.
   *
   * Lazy because a message may carry a 20 MB attachment the size policy is
   * about to decline anyway (§5.10), and walking its sector chain to build a
   * copy nobody keeps is pure waste.
   */
  read(): Uint8Array;
}

export interface CompoundFile {
  root: CfbEntry;
  /** 3 or 4. Recorded because the two differ in sector size. */
  majorVersion: number;
}

/** A cheap look at the first eight bytes. Used to pick a parser, not to trust one. */
export function isCompoundFile(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function readCompoundFile(bytes: Uint8Array): CompoundFile {
  if (!isCompoundFile(bytes)) throw new CfbError("Not a compound file.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const majorVersion = view.getUint16(26, true);
  const sectorShift = view.getUint16(30, true);
  const miniSectorShift = view.getUint16(32, true);

  // Only the two shifts the specification defines. A file claiming anything
  // else is either corrupt or from a writer nobody has, and guessing a sector
  // size turns a clean refusal into a stream of garbage.
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new CfbError(`Unsupported sector size (shift ${sectorShift}).`);
  }
  if (miniSectorShift !== 6) {
    throw new CfbError(`Unsupported mini sector size (shift ${miniSectorShift}).`);
  }

  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const miniCutoff = view.getUint32(56, true);
  const sectorCount = Math.max(0, Math.floor((bytes.length - 512) / sectorSize));

  const fat = readFat(bytes, view, sectorSize, sectorCount);
  const reader = new SectorReader(bytes, sectorSize, sectorCount, fat);

  const directory = reader.chain(view.getUint32(48, true));
  const entries = directoryEntries(directory, majorVersion);
  if (entries.length === 0) throw new CfbError("The directory is empty.");

  const rootEntry = entries[0]!;
  if (rootEntry.type !== TYPE_ROOT) throw new CfbError("No root storage entry.");

  // The mini stream is an ordinary stream hanging off the root entry; the mini
  // FAT then chains 64-byte slots *inside* it. Both are read eagerly because
  // every short stream in the file — which is most of them — needs them.
  const miniFat = readMiniFat(reader, view);
  const miniStream = reader.chain(rootEntry.startSector, rootEntry.size);

  // One shared visited set across the whole directory. No legitimate file
  // reaches an entry twice, so this is both the cycle guard and the guarantee
  // that a malicious directory cannot be made to expand without end.
  const seen = new Set<number>();

  const build = (index: number, depth: number): CfbEntry | null => {
    const entry = entries[index]!;
    if (entry.type !== TYPE_STORAGE && entry.type !== TYPE_STREAM) return null;

    const node: CfbEntry = {
      name: entry.name,
      kind: entry.type === TYPE_STORAGE ? "storage" : "stream",
      children: [],
      size: entry.type === TYPE_STREAM ? entry.size : 0,
      read: () =>
        entry.type !== TYPE_STREAM
          ? new Uint8Array(0)
          : entry.size < miniCutoff
            ? readMini(miniStream, miniFat, miniSectorSize, entry.startSector, entry.size)
            : reader.chain(entry.startSector, entry.size),
    };

    if (entry.type === TYPE_STORAGE && depth < MAX_TREE_DEPTH) {
      node.children = childrenOf(entry.child, entries, seen, depth + 1, build);
    }

    return node;
  };

  const root: CfbEntry = {
    name: rootEntry.name,
    kind: "storage",
    children: childrenOf(rootEntry.child, entries, seen, 1, build),
    size: 0,
    read: () => new Uint8Array(0),
  };

  return { root, majorVersion };
}

/** How deep a storage tree may nest. A `.msg` uses three levels at most. */
const MAX_TREE_DEPTH = 16;

/**
 * Enumerate one storage's children.
 *
 * The children of a storage are held as a red-black tree linked by `left` and
 * `right`, rooted at the storage's `child` pointer. The colouring exists to
 * keep insertion balanced and means nothing to a reader, so this is an ordinary
 * traversal — iterative with an explicit stack, because the shape of the tree
 * is decided by whoever wrote the file.
 *
 * The result is sorted by name. A tree walk has no inherent order, and a vault
 * is a record: the same file must produce the same note twice running.
 */
function childrenOf(
  first: number,
  entries: readonly RawEntry[],
  seen: Set<number>,
  depth: number,
  build: (index: number, depth: number) => CfbEntry | null,
): CfbEntry[] {
  const out: CfbEntry[] = [];
  const pending: number[] = [first];

  while (pending.length > 0) {
    const index = pending.pop()!;
    if (index === NO_STREAM || index >= entries.length || seen.has(index)) continue;
    seen.add(index);

    const entry = entries[index]!;
    pending.push(entry.left, entry.right);

    const node = build(index, depth);
    if (node !== null) out.push(node);
  }

  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

interface RawEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
}

function directoryEntries(directory: Uint8Array, majorVersion: number): RawEntry[] {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const count = Math.floor(directory.length / DIRECTORY_ENTRY_SIZE);
  const entries: RawEntry[] = [];

  for (let i = 0; i < count; i++) {
    const at = i * DIRECTORY_ENTRY_SIZE;
    const nameBytes = view.getUint16(at + 64, true);
    // Length includes the terminating NUL, and a broken writer may overstate
    // it; clamping keeps a bad entry from eating the next one's name.
    const chars = Math.max(0, Math.min(31, Math.floor(nameBytes / 2) - 1));

    let name = "";
    for (let c = 0; c < chars; c++) name += String.fromCharCode(view.getUint16(at + c * 2, true));

    // Version 3 keeps stream sizes below 2 GB and the high word must be zero,
    // but writers exist that leave rubbish there; only version 4 is trusted
    // with it.
    const low = view.getUint32(at + 120, true);
    const high = majorVersion >= 4 ? view.getUint32(at + 124, true) : 0;

    entries.push({
      name,
      type: view.getUint8(at + 66),
      left: view.getUint32(at + 68, true),
      right: view.getUint32(at + 72, true),
      child: view.getUint32(at + 76, true),
      startSector: view.getUint32(at + 116, true),
      size: high * 0x1_0000_0000 + low,
    });
  }

  return entries;
}

/**
 * Assemble the FAT.
 *
 * Its own sector numbers are listed in the DIFAT: the first 109 in the header,
 * the rest in a chain of DIFAT sectors, each of which ends with a pointer to
 * the next. This double indirection is what lets the format address a large
 * file with a 512-byte header.
 */
function readFat(
  bytes: Uint8Array,
  view: DataView,
  sectorSize: number,
  sectorCount: number,
): Uint32Array {
  const fatSectorCount = view.getUint32(44, true);
  const difat: number[] = [];

  for (let i = 0; i < 109; i++) {
    const sector = view.getUint32(76 + i * 4, true);
    if (sector >= MAX_REGULAR) break;
    difat.push(sector);
  }

  const perDifatSector = sectorSize / 4 - 1;
  let next = view.getUint32(68, true);
  let guard = view.getUint32(72, true) + 8;

  while (next < MAX_REGULAR && difat.length < fatSectorCount && guard-- > 0) {
    const at = (next + 1) * sectorSize;
    if (at + sectorSize > bytes.length) break;
    for (let i = 0; i < perDifatSector; i++) {
      const sector = view.getUint32(at + i * 4, true);
      if (sector >= MAX_REGULAR) continue;
      difat.push(sector);
    }
    next = view.getUint32(at + perDifatSector * 4, true);
  }

  const fat = new Uint32Array(difat.length * (sectorSize / 4)).fill(FREE_SECTOR);
  let write = 0;
  for (const sector of difat) {
    const at = (sector + 1) * sectorSize;
    if (at + sectorSize > bytes.length) break;
    for (let i = 0; i < sectorSize / 4; i++) fat[write++] = view.getUint32(at + i * 4, true);
  }

  if (write === 0 && sectorCount > 0) throw new CfbError("No usable allocation table.");
  return fat;
}

function readMiniFat(reader: SectorReader, view: DataView): Uint32Array {
  const bytes = reader.chain(view.getUint32(60, true));
  const table = new Uint32Array(Math.floor(bytes.length / 4));
  const chunk = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < table.length; i++) table[i] = chunk.getUint32(i * 4, true);
  return table;
}

/** Reads sector chains out of the file. */
class SectorReader {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly sectorSize: number,
    private readonly sectorCount: number,
    private readonly fat: Uint32Array,
  ) {}

  /**
   * Follow a chain from `start`, optionally truncated to `size`.
   *
   * The walk is bounded by the number of sectors the file physically has, so a
   * FAT whose entries form a ring stops instead of allocating forever.
   */
  chain(start: number, size?: number): Uint8Array {
    if (start >= MAX_REGULAR) return new Uint8Array(0);

    const sectors: number[] = [];
    const seen = new Set<number>();
    let sector = start;

    while (sector < MAX_REGULAR && sector !== END_OF_CHAIN) {
      if (seen.has(sector) || sectors.length > this.sectorCount + 1) {
        throw new CfbError("A sector chain loops back on itself.");
      }
      seen.add(sector);
      sectors.push(sector);
      sector = sector < this.fat.length ? this.fat[sector]! : END_OF_CHAIN;
    }

    const wanted = size === undefined ? sectors.length * this.sectorSize : size;
    const out = new Uint8Array(Math.min(wanted, sectors.length * this.sectorSize));
    let write = 0;

    for (const index of sectors) {
      if (write >= out.length) break;
      const at = (index + 1) * this.sectorSize;
      const take = Math.min(this.sectorSize, out.length - write, Math.max(0, this.bytes.length - at));
      if (take <= 0) break;
      out.set(this.bytes.subarray(at, at + take), write);
      write += take;
    }

    return write === out.length ? out : out.subarray(0, write);
  }
}

/** Follow a chain through the mini FAT, inside the already-read mini stream. */
function readMini(
  miniStream: Uint8Array,
  miniFat: Uint32Array,
  miniSectorSize: number,
  start: number,
  size: number,
): Uint8Array {
  const out = new Uint8Array(size);
  const seen = new Set<number>();
  let sector = start;
  let write = 0;

  while (sector < MAX_REGULAR && sector !== END_OF_CHAIN && write < size) {
    if (seen.has(sector)) throw new CfbError("A mini sector chain loops back on itself.");
    seen.add(sector);

    const at = sector * miniSectorSize;
    const take = Math.min(miniSectorSize, size - write, Math.max(0, miniStream.length - at));
    if (take <= 0) break;
    out.set(miniStream.subarray(at, at + take), write);
    write += take;

    sector = sector < miniFat.length ? miniFat[sector]! : END_OF_CHAIN;
  }

  return write === size ? out : out.subarray(0, write);
}

/** A named child, case-sensitively. Storage names in a `.msg` are exact. */
export function childNamed(entry: CfbEntry, name: string): CfbEntry | undefined {
  return entry.children.find((child) => child.name === name);
}
