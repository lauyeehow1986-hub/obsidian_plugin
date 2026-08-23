/**
 * A minimal compound-file / `.msg` writer, for tests only.
 *
 * Lives outside `src/` deliberately: it is fixture scaffolding, it must never
 * reach the plugin bundle, and nothing in `domain/` may depend on it.
 *
 * ## Why a writer rather than a checked-in binary
 *
 * Vault content never enters this repository (CLAUDE.md §2 rule 1), and a real
 * `.msg` dragged out of a mailbox is vault content — it carries names, subjects
 * and addresses. So the fixtures are synthesised here from declared inputs,
 * which also makes them readable in a diff.
 *
 * ## What this does and does not prove
 *
 * Testing a parser against its own author's writer risks sharing a
 * misunderstanding of the format. So the container layer is *also* verified
 * against compound files this project did not write — see `cfb.test.ts` — and
 * the MAPI layer against a real message on the target machine before release.
 * This writer proves the parser handles a file it did not itself lay out in
 * memory; it does not, on its own, prove the format was read correctly.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const DIFAT_SECTOR = 0xfffffffc;
const FAT_SECTOR = 0xfffffffd;
const FREE_SECTOR = 0xffffffff;
const NO_STREAM = 0xffffffff;

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;

/* ------------------------------------------------------- the file tree -- */

export type Node = StorageNode | StreamNode;

export interface StorageNode {
  kind: "storage";
  name: string;
  children: Node[];
}

export interface StreamNode {
  kind: "stream";
  name: string;
  bytes: Uint8Array;
}

export function storage(name: string, children: Node[]): StorageNode {
  return { kind: "storage", name, children };
}

export function stream(name: string, bytes: Uint8Array): StreamNode {
  return { kind: "stream", name, bytes };
}

/* -------------------------------------------------------------- writing -- */

interface Entry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/**
 * Lay out a compound file.
 *
 * Sectors are allocated in a fixed order — big streams, the mini stream, the
 * mini FAT, the directory, then the FAT itself — which keeps the arithmetic
 * legible at the cost of producing a file no real writer would produce byte for
 * byte. That is fine and arguably better: the reader must not depend on layout.
 */
export function writeCompoundFile(root: StorageNode): Uint8Array {
  const entries: Entry[] = [
    { name: "Root Entry", type: 5, left: NO_STREAM, right: NO_STREAM, child: NO_STREAM, start: 0, size: 0 },
  ];

  // Payloads are keyed by directory-entry index, never by name: a `.msg` has
  // one `__properties_version1.0` stream per storage, so a name is not unique
  // in the file and keying on it silently gives every storage the last one's
  // bytes.
  const payloads = new Map<number, Uint8Array>();

  // Depth-first, allocating a directory entry per node, then linking each
  // storage's children as a balanced tree.
  const addChildren = (children: readonly Node[]): number => {
    const indices = [...children]
      .sort((a, b) => compareNames(a.name, b.name))
      .map((child) => {
        const index = entries.length;
        entries.push({
          name: child.name,
          type: child.kind === "storage" ? 1 : 2,
          left: NO_STREAM,
          right: NO_STREAM,
          child: NO_STREAM,
          start: 0,
          size: child.kind === "stream" ? child.bytes.length : 0,
        });
        if (child.kind === "storage") entries[index]!.child = addChildren(child.children);
        else payloads.set(index, child.bytes);
        return index;
      });
    return link(entries, indices);
  };

  entries[0]!.child = addChildren(root.children);

  // In directory-entry order, so the fixture is byte-for-byte deterministic.
  const big: { index: number; bytes: Uint8Array }[] = [];
  const small: { index: number; bytes: Uint8Array }[] = [];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.type !== 2) continue;
    const bytes = payloads.get(i) ?? new Uint8Array(0);
    (bytes.length >= MINI_CUTOFF ? big : small).push({ index: i, bytes });
  }

  // --- mini stream: every short stream packed at 64-byte granularity.
  let miniLength = 0;
  const miniPlan = small.map(({ index, bytes }) => {
    const at = miniLength;
    miniLength += Math.ceil(Math.max(bytes.length, 1) / MINI_SECTOR) * MINI_SECTOR;
    return { index, bytes, at };
  });
  const miniStream = new Uint8Array(miniLength);
  for (const { bytes, at } of miniPlan) miniStream.set(bytes, at);

  const miniSectorCount = miniLength / MINI_SECTOR;
  const miniFatSectors = Math.ceil((miniSectorCount * 4) / SECTOR);
  const miniStreamSectors = Math.ceil(miniLength / SECTOR);
  const dirSectors = Math.ceil(entries.length / 4);
  const bigSectors = big.reduce((n, { bytes }) => n + Math.ceil(bytes.length / SECTOR), 0);

  const nonFat = bigSectors + miniStreamSectors + miniFatSectors + dirSectors;

  // The FAT has to describe its own sectors, and once it needs more than the
  // 109 slots the header holds, the overflow list needs sectors of its own that
  // the FAT must also describe. Both counts are solved by iterating to a fixed
  // point — three passes is more than enough for any size this reaches.
  const PER_DIFAT = SECTOR / 4 - 1; // the last slot chains to the next one
  let fatSectors = 1;
  let difatSectors = 0;
  for (let i = 0; i < 8; i++) {
    fatSectors = Math.max(1, Math.ceil((nonFat + fatSectors + difatSectors) / (SECTOR / 4)));
    difatSectors = Math.max(0, Math.ceil((fatSectors - 109) / PER_DIFAT));
  }

  const total = nonFat + fatSectors + difatSectors;
  const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREE_SECTOR);
  const file = new Uint8Array(SECTOR * (total + 1));
  const view = new DataView(file.buffer);

  let next = 0;
  const allocate = (bytes: Uint8Array): number => {
    const count = Math.max(1, Math.ceil(bytes.length / SECTOR));
    const first = next;
    file.set(bytes, SECTOR * (first + 1));
    for (let i = 0; i < count; i++) fat[first + i] = i === count - 1 ? END_OF_CHAIN : first + i + 1;
    next += count;
    return first;
  };

  for (const { index, bytes } of big) entries[index]!.start = allocate(bytes);

  const miniStart = miniLength === 0 ? END_OF_CHAIN : allocate(miniStream);
  entries[0]!.start = miniStart;
  entries[0]!.size = miniLength;
  for (const { index, at } of miniPlan) entries[index]!.start = at / MINI_SECTOR;

  const miniFat = new Uint32Array(miniFatSectors * (SECTOR / 4)).fill(FREE_SECTOR);
  for (const { index, bytes } of miniPlan) {
    const count = Math.max(1, Math.ceil(bytes.length / MINI_SECTOR));
    const first = entries[index]!.start;
    for (let i = 0; i < count; i++) miniFat[first + i] = i === count - 1 ? END_OF_CHAIN : first + i + 1;
  }
  const miniFatStart = miniFatSectors === 0 ? END_OF_CHAIN : allocate(u32le(miniFat));

  const directory = new Uint8Array(dirSectors * SECTOR);
  const dirView = new DataView(directory.buffer);
  entries.forEach((entry, i) => writeEntry(dirView, i * 128, entry));
  // Unused slots in the last directory sector must read as unallocated.
  for (let i = entries.length; i < dirSectors * 4; i++) dirView.setUint8(i * 128 + 66, 0);
  const dirStart = allocate(directory);

  const fatStart = next;
  next += fatSectors;
  const difatStart = difatSectors === 0 ? END_OF_CHAIN : next;

  for (let i = 0; i < fatSectors; i++) fat[fatStart + i] = FAT_SECTOR;
  for (let i = 0; i < difatSectors; i++) fat[difatStart + i] = DIFAT_SECTOR;

  // Overflow FAT sector numbers, 127 per sector, each ending with a pointer to
  // the next one.
  for (let i = 0; i < difatSectors; i++) {
    const sector = new Uint32Array(SECTOR / 4).fill(FREE_SECTOR);
    for (let slot = 0; slot < PER_DIFAT; slot++) {
      const which = 109 + i * PER_DIFAT + slot;
      if (which < fatSectors) sector[slot] = fatStart + which;
    }
    sector[PER_DIFAT] = i === difatSectors - 1 ? END_OF_CHAIN : difatStart + i + 1;
    file.set(u32le(sector), SECTOR * (difatStart + i + 1));
  }

  file.set(u32le(fat), SECTOR * (fatStart + 1));

  /* header */
  for (let i = 0; i < 8; i++) view.setUint8(i, SIGNATURE[i]!);
  view.setUint16(24, 0x003e, true); // minor version
  view.setUint16(26, 3, true); // major version
  view.setUint16(28, 0xfffe, true); // little-endian marker
  view.setUint16(30, 9, true); // 512-byte sectors
  view.setUint16(32, 6, true); // 64-byte mini sectors
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, dirStart, true);
  view.setUint32(56, MINI_CUTOFF, true);
  view.setUint32(60, miniFatStart, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, difatStart, true);
  view.setUint32(72, difatSectors, true);
  for (let i = 0; i < 109; i++) {
    view.setUint32(76 + i * 4, i < fatSectors ? fatStart + i : FREE_SECTOR, true);
  }

  return file;
}

function writeEntry(view: DataView, at: number, entry: Entry): void {
  for (let i = 0; i < entry.name.length && i < 31; i++) {
    view.setUint16(at + i * 2, entry.name.charCodeAt(i), true);
  }
  view.setUint16(at + 64, Math.min(entry.name.length, 31) * 2 + 2, true);
  view.setUint8(at + 66, entry.type);
  view.setUint8(at + 67, 1); // black; the colour is never read back
  view.setUint32(at + 68, entry.left, true);
  view.setUint32(at + 72, entry.right, true);
  view.setUint32(at + 76, entry.child, true);
  view.setUint32(at + 116, entry.start, true);
  view.setUint32(at + 120, entry.size, true);
}

/** Build a balanced left/right tree over already-sorted indices. */
function link(entries: Entry[], indices: readonly number[]): number {
  if (indices.length === 0) return NO_STREAM;
  const middle = Math.floor(indices.length / 2);
  const node = indices[middle]!;
  entries[node]!.left = link(entries, indices.slice(0, middle));
  entries[node]!.right = link(entries, indices.slice(middle + 1));
  return node;
}

/** Directory ordering is by name length then upper-cased code units (MS-CFB §2.6.4). */
function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function u32le(values: Uint32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return out;
}

/* ------------------------------------------------------- MAPI shortcuts -- */

/** Property types, as they appear in the low half of a tag. */
export const PT_UNICODE = 0x001f;
export const PT_STRING8 = 0x001e;
export const PT_BINARY = 0x0102;
export const PT_LONG = 0x0003;
export const PT_BOOLEAN = 0x000b;
export const PT_SYSTIME = 0x0040;

export interface Prop {
  id: number;
  type: number;
  value: string | number | boolean | Uint8Array | Date;
}

export function prop(id: number, type: number, value: Prop["value"]): Prop {
  return { id, type, value };
}

const tagName = (id: number, type: number) =>
  `__substg1.0_${id.toString(16).padStart(4, "0").toUpperCase()}${type.toString(16).padStart(4, "0").toUpperCase()}`;

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

function cp1252(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));
}

/** FILETIME: 100-nanosecond ticks since 1601-01-01 UTC. */
export function fileTime(date: Date): { low: number; high: number } {
  const ticks = BigInt(date.getTime() + 11_644_473_600_000) * 10_000n;
  return { low: Number(ticks & 0xffffffffn), high: Number(ticks >> 32n) };
}

/**
 * Turn declared properties into the streams and fixed-property table a `.msg`
 * storage holds.
 *
 * `headerSize` differs by storage: 32 bytes for the top-level message, 8 for a
 * recipient or attachment (MS-OXMSG §2.4).
 */
export function propertyNodes(props: readonly Prop[], headerSize: number): Node[] {
  const nodes: Node[] = [];
  const fixed: { tag: number; value: Uint8Array }[] = [];

  for (const { id, type, value } of props) {
    const eight = new Uint8Array(8);
    const view = new DataView(eight.buffer);

    switch (type) {
      case PT_UNICODE:
        nodes.push(stream(tagName(id, type), utf16le(String(value))));
        view.setUint32(0, String(value).length * 2, true);
        break;
      case PT_STRING8:
        nodes.push(stream(tagName(id, type), cp1252(String(value))));
        view.setUint32(0, String(value).length, true);
        break;
      case PT_BINARY: {
        const bytes = value as Uint8Array;
        nodes.push(stream(tagName(id, type), bytes));
        view.setUint32(0, bytes.length, true);
        break;
      }
      case PT_LONG:
        view.setUint32(0, Number(value) >>> 0, true);
        break;
      case PT_BOOLEAN:
        view.setUint16(0, value === true ? 1 : 0, true);
        break;
      case PT_SYSTIME: {
        const { low, high } = fileTime(value as Date);
        view.setUint32(0, low, true);
        view.setUint32(4, high, true);
        break;
      }
      default:
        throw new Error(`fixture writer does not handle property type ${type}`);
    }

    fixed.push({ tag: ((id << 16) >>> 0) | type, value: eight });
  }

  const table = new Uint8Array(headerSize + fixed.length * 16);
  const tableView = new DataView(table.buffer);
  fixed.forEach(({ tag, value }, i) => {
    const at = headerSize + i * 16;
    tableView.setUint32(at, tag >>> 0, true);
    tableView.setUint32(at + 4, 6, true); // readable | writeable
    table.set(value, at + 8);
  });

  nodes.push(stream("__properties_version1.0", table));
  return nodes;
}

export interface MsgSpec {
  props: Prop[];
  recipients?: Prop[][];
  attachments?: Prop[][];
}

/** Assemble a whole `.msg` file from declared properties. */
export function writeMsg(spec: MsgSpec): Uint8Array {
  const children: Node[] = [...propertyNodes(spec.props, 32)];

  (spec.recipients ?? []).forEach((props, i) => {
    children.push(
      storage(`__recip_version1.0_#${i.toString(16).padStart(8, "0").toUpperCase()}`, propertyNodes(props, 8)),
    );
  });
  (spec.attachments ?? []).forEach((props, i) => {
    children.push(
      storage(`__attach_version1.0_#${i.toString(16).padStart(8, "0").toUpperCase()}`, propertyNodes(props, 8)),
    );
  });

  return writeCompoundFile(storage("Root Entry", children));
}
