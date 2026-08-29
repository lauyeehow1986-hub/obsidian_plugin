import { describe, expect, it } from "vitest";

import {
  describeCapabilities,
  parseCapabilities,
  parseManifest,
  replaceSource,
  VAULT_APP_TYPE,
} from "./manifest";

function note(frontmatter: Record<string, unknown>, body = "```js app\nmount(() => null);\n```") {
  return parseManifest({ path: "92 Apps/APP-x.md", frontmatter, body });
}

describe("the vault-app manifest (§5.13)", () => {
  it("reads a well-formed manifest", () => {
    const manifest = note({
      type: VAULT_APP_TYPE,
      id: "APP-turnaround",
      title: "Turnaround explorer",
      capabilities: { query: ["scdb-request", "run"], write: "none", network: false },
      export: "allowed",
    });
    expect(manifest.capabilities.query).toEqual(["scdb-request", "run"]);
    expect(manifest.capabilities.write).toBe("none");
    expect(manifest.export).toBe("allowed");
    expect(manifest.problems).toEqual([]);
    expect(manifest.source.trim()).toBe("mount(() => null);");
  });

  /**
   * The direction a lenient parser must never fail in. Every malformed shape
   * below has to end up granting *less*, not more — this is the whole reason
   * the manifest is parsed rather than spread.
   */
  describe("anything unreadable narrows", () => {
    it("grants nothing when capabilities are missing", () => {
      const manifest = note({ id: "APP-x" });
      expect(manifest.capabilities).toEqual({ query: [], write: "none", network: false });
      expect(manifest.problems.join(" ")).toMatch(/No `capabilities:` block/);
    });

    it("grants nothing when capabilities are not a block", () => {
      const problems: string[] = [];
      expect(parseCapabilities("everything", problems).query).toEqual([]);
      expect(problems.join(" ")).toMatch(/not a block of settings/);
    });

    it("grants no reads when query is not a list", () => {
      const problems: string[] = [];
      expect(parseCapabilities({ query: 42 }, problems).query).toEqual([]);
      expect(problems.join(" ")).toMatch(/may read nothing/);
    });

    it("reads an unrecognised write mode as none, and says so", () => {
      const problems: string[] = [];
      expect(parseCapabilities({ write: "always" }, problems).write).toBe("none");
      expect(problems.join(" ")).toMatch(/read as "none"/);
    });

    it("drops a query entry that is not a type name", () => {
      const problems: string[] = [];
      expect(parseCapabilities({ query: ["run", {}, ""] }, problems).query).toEqual(["run"]);
      expect(problems.join(" ")).toMatch(/was ignored/);
    });

    it("de-duplicates types so a doubled entry is not two grants", () => {
      expect(parseCapabilities({ query: ["run", "run"] }, []).query).toEqual(["run"]);
    });
  });

  /** Rule 3: outbound traffic goes through one gateway, and no app is it. */
  it("refuses network access rather than honouring it, and says why", () => {
    const problems: string[] = [];
    const capabilities = parseCapabilities({ network: true }, problems);
    expect(capabilities.network).toBe(false);
    expect(problems.join(" ")).toMatch(/Vault apps never get it/);
  });

  it("accepts a single type written without a list", () => {
    expect(parseCapabilities({ query: "scdb-request" }, []).query).toEqual(["scdb-request"]);
  });

  describe("the source block", () => {
    it("says there is nothing to run when the note has no js fence", () => {
      const manifest = note({ id: "APP-x" }, "# An app\n\nProse only.\n");
      expect(manifest.problems.join(" ")).toMatch(/nothing to run/);
      expect(manifest.source).toBe("");
    });

    it("says there is nothing to run when the fence is empty", () => {
      const manifest = note({ id: "APP-x" }, "```js app\n\n```");
      expect(manifest.problems.join(" ")).toMatch(/nothing to run/);
    });

    it("prefers the tagged fence over an unrelated js example", () => {
      const body = ["```js", "// an example in the prose", "```", "", "```js app", "mount(A);", "```"].join("\n");
      expect(note({ id: "APP-x" }, body).source.trim()).toBe("mount(A);");
    });

    /** Rule 8 and §5.1: the plugin never rewrites prose. */
    it("replaces only the block when the source is written back", () => {
      const body = ["# Title", "", "Why this app exists.", "", "```js app", "old();", "```", "", "Trailing note."].join("\n");
      const after = replaceSource(body, "fresh();");
      expect(after).toContain("Why this app exists.");
      expect(after).toContain("Trailing note.");
      expect(after).toContain("fresh();");
      expect(after).not.toContain("old();");
    });
  });

  it("falls back to the file name for an id, and warns that consent is tied to it", () => {
    const manifest = parseManifest({
      path: "92 Apps/APP-unnamed.md",
      frontmatter: {},
      body: "```js app\nmount(A);\n```",
    });
    expect(manifest.id).toBe("APP-unnamed");
    expect(manifest.problems.join(" ")).toMatch(/renaming the note loses this app's consent/);
  });

  it("summarises what an app may reach in one line", () => {
    expect(describeCapabilities({ query: ["run"], write: "propose", network: false })).toBe(
      "reads run · may propose writes · no network",
    );
    expect(describeCapabilities({ query: [], write: "none", network: false })).toBe(
      "reads nothing · cannot write · no network",
    );
  });
});
