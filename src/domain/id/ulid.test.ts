import { describe, expect, it } from "vitest";
import { isUlid, ULID_LENGTH, ulid, ulidTime } from "./ulid.js";

const bytes = (fill: number) => new Uint8Array(16).fill(fill);

describe("ulid", () => {
  it("produces a 26-character Crockford base32 string", () => {
    const id = ulid();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("excludes the ambiguous letters I, L, O and U", () => {
    // 10k ids is enough to hit every alphabet slot many times over.
    const all = Array.from({ length: 10_000 }, () => ulid()).join("");
    expect(all).not.toMatch(/[ILOU]/);
  });

  it("round-trips the timestamp", () => {
    const now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    expect(ulidTime(ulid(now, bytes(1)))).toBe(now);
  });

  it("sorts lexicographically in creation order", () => {
    const early = ulid(1_000_000_000_000, bytes(31));
    const late = ulid(1_000_000_000_001, bytes(0));
    // Later id sorts after the earlier one even though its random half is lower.
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("does not collide across many generations in the same millisecond", () => {
    const frozen = 1_767_225_600_000;
    const ids = new Set(Array.from({ length: 20_000 }, () => ulid(frozen)));
    expect(ids.size).toBe(20_000);
  });

  it("rejects timestamps outside the encodable range", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(281_474_976_710_656)).toThrow(RangeError);
  });

  it("rejects short random input rather than emitting a malformed id", () => {
    expect(() => ulid(Date.now(), new Uint8Array(4))).toThrow(RangeError);
  });

  describe("isUlid", () => {
    it("accepts a generated id", () => {
      expect(isUlid(ulid())).toBe(true);
    });

    it.each([
      ["wrong length", "01J8Z3QK7M2R"],
      ["ambiguous letter", "0".repeat(25) + "I"],
      ["lowercase", ulid().toLowerCase()],
      ["not a string", 12345],
      ["null", null],
    ])("rejects %s", (_label, value) => {
      expect(isUlid(value)).toBe(false);
    });
  });

  it("ulidTime refuses a non-ULID instead of returning nonsense", () => {
    expect(() => ulidTime("nope")).toThrow(TypeError);
  });
});
