import { describe, expect, it } from "vitest";
import { sha256, sha256Bytes } from "./sha256";

describe("sha256", () => {
  // FIPS 180-4 / NIST published vectors. If any of these move, the whole audit
  // ledger's chain values move with them, so they are pinned deliberately.
  it("matches the published NIST vectors", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(
      sha256(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno" +
          "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  });

  it("handles the one-million-'a' vector", () => {
    expect(sha256("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  // Padding is where hand-written SHA-256 breaks: 55 bytes is the last length
  // that fits its length field in the same block, 56 forces an extra block.
  it("pads correctly around the block boundary", () => {
    expect(sha256("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(sha256("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("hashes strings as UTF-8, not UTF-16", () => {
    // "é" is two bytes in UTF-8. A UTF-16 implementation would differ here.
    expect(sha256("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });

  it("accepts raw bytes", () => {
    expect(sha256Bytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256("abc"));
    expect(sha256Bytes(new Uint8Array(0))).toBe(sha256(""));
  });
});
