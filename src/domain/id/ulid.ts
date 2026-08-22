/**
 * ULID generation — the immutable `uid` every note carries (CLAUDE.md §5.1).
 *
 * Sequential IDs like REQ-2026-014 collide the moment a second person creates a
 * request at the same time. ULIDs are collision-free without coordination and
 * still sort by creation time, which sequential-per-vault IDs cannot promise
 * across two machines.
 *
 * Pure module: no Obsidian, no Node. Uses Web Crypto, present in both Electron
 * and Node >= 19.
 */

/** Crockford base32: no I, L, O or U, so a transcribed ID cannot be misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** Largest timestamp encodable in 10 base32 chars (48 bits) — year 10889. */
const MAX_TIME = 281_474_976_710_655;

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  let out = "";
  let remaining = now;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(random: Uint8Array): string {
  let out = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    // Each byte is masked to 5 bits; we consume one byte per character rather
    // than packing, which costs entropy we do not need and buys clarity.
    out += ALPHABET[random[i]! & 0x1f]!;
  }
  return out;
}

/**
 * Generate a ULID. `now` and `randomBytes` are injectable so tests are
 * deterministic — production callers pass neither.
 */
export function ulid(now: number = Date.now(), randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(RANDOM_CHARS));
  if (bytes.length < RANDOM_CHARS) {
    throw new RangeError(`ULID needs ${RANDOM_CHARS} random bytes, got ${bytes.length}`);
  }
  return encodeTime(now) + encodeRandom(bytes);
}

/** True if `value` is a syntactically valid ULID. Used by the integrity check (A4). */
export function isUlid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== ULID_LENGTH) return false;
  for (const ch of value) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Recover the creation timestamp. Lets us sort or audit without a stored date. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) throw new TypeError(`Not a ULID: ${value}`);
  let time = 0;
  for (let i = 0; i < TIME_CHARS; i++) {
    time = time * 32 + ALPHABET.indexOf(value[i]!);
  }
  return time;
}
