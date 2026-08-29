import { describe, expect, it } from "vitest";

import { checkGrant, describeGrant, grantHash, newGrant, type AppGrant } from "./grant";
import type { AppCapabilities } from "./manifest";

function caps(query: string[], write: "none" | "propose" = "none"): AppCapabilities {
  return { query, write, network: false };
}

describe("consent to run a vault app (§5.13)", () => {
  it("treats an app with no grant as new, and refuses to run it", () => {
    const check = checkGrant(caps(["run"]), undefined);
    expect(check.verdict).toBe("new");
    expect(check.runnable).toBe(false);
  });

  it("runs an app whose manifest still matches what was granted", () => {
    const grant = newGrant(caps(["scdb-request", "run"]), "2026-08-29");
    const check = checkGrant(caps(["scdb-request", "run"]), grant);
    expect(check.verdict).toBe("unchanged");
    expect(check.runnable).toBe(true);
  });

  /**
   * A prompt raised by a cosmetic edit is a prompt that gets clicked through,
   * so the hash is over canonicalised capabilities rather than over the text.
   */
  it("does not re-prompt when the type list is merely re-ordered", () => {
    const grant = newGrant(caps(["run", "scdb-request"]), "2026-08-29");
    expect(checkGrant(caps(["scdb-request", "run"]), grant).verdict).toBe("unchanged");
    expect(grantHash(caps(["a", "b"]))).toBe(grantHash(caps(["b", "a"])));
  });

  describe("a manifest that widens", () => {
    it("refuses to run, and names the type that was added", () => {
      const grant = newGrant(caps(["scdb-request"]), "2026-08-29");
      const check = checkGrant(caps(["scdb-request", "correspondence"]), grant);
      expect(check.verdict).toBe("widened");
      expect(check.runnable).toBe(false);
      expect(check.changes.join(" ")).toMatch(/also wants to read: correspondence/);
    });

    it("catches write access appearing on an app that had none", () => {
      const grant = newGrant(caps(["run"], "none"), "2026-08-29");
      const check = checkGrant(caps(["run"], "propose"), grant);
      expect(check.verdict).toBe("widened");
      expect(check.changes.join(" ")).toMatch(/propose changes to notes/);
    });
  });

  /** §5.13: "Narrowing does not." Asking about less would train you to click through. */
  describe("a manifest that narrows", () => {
    it("runs without asking again when a type is dropped", () => {
      const grant = newGrant(caps(["scdb-request", "run"]), "2026-08-29");
      const check = checkGrant(caps(["run"]), grant);
      expect(check.verdict).toBe("narrowed");
      expect(check.runnable).toBe(true);
      expect(check.changes.join(" ")).toMatch(/no longer reads: scdb-request/);
    });

    it("runs without asking again when write access is given up", () => {
      const grant = newGrant(caps(["run"], "propose"), "2026-08-29");
      const check = checkGrant(caps(["run"], "none"), grant);
      expect(check.verdict).toBe("narrowed");
      expect(check.runnable).toBe(true);
    });
  });

  /**
   * Settings are a JSON file on disk. The failure mode of trusting a
   * half-written one is running an app nobody consented to, so a grant that
   * cannot be read is not a grant.
   */
  it("reads a malformed stored grant as no grant at all", () => {
    const broken = { at: "2026-08-29" } as unknown as AppGrant;
    expect(checkGrant(caps(["run"]), broken).verdict).toBe("new");
    expect(checkGrant(caps(["run"]), { hash: "", at: "", capabilities: caps([]) }).runnable).toBe(
      false,
    );
  });

  it("survives a stored grant whose capabilities went missing", () => {
    const grant = { hash: "notthehash", at: "2026-08-29" } as unknown as AppGrant;
    const check = checkGrant(caps(["run"]), grant);
    expect(check.verdict).toBe("widened");
    expect(check.changes.join(" ")).toMatch(/run/);
  });

  it("describes a grant for the ledger in names and counts only", () => {
    expect(describeGrant(caps(["scdb-request"], "propose"))).toBe(
      "reads scdb-request; write propose; network false",
    );
  });
});
