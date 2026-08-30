/**
 * The release checklist, enforced rather than remembered (CLAUDE.md §10).
 *
 * A release touches six files, and five of them are obvious because the build
 * fails or the plugin misbehaves without them. The sixth is prose: the README
 * and the documentation site both write the version out in words, and nothing
 * anywhere notices when they go stale. That is exactly the failure mode a
 * checklist is worst at catching — the step is small, it is last, and skipping
 * it produces no symptom until someone downloads a release the docs describe as
 * a different version.
 *
 * So the version is checked the same way the Outlook reader's guarantees are:
 * by reading the files and failing. When this test goes red the fix is to
 * update whichever file it names, not to relax the assertion.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const manifest = JSON.parse(read("manifest.json")) as {
  version: string;
  minAppVersion: string;
  id: string;
};

describe("everything a release has to touch agrees on the version", () => {
  it("has a plausible SemVer in the manifest", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.id).toBe("scdb-cockpit");
  });

  it("mirrors it in versions.json with a minAppVersion", () => {
    // Obsidian reads this to decide which release an older app may install.
    // A missing entry is silent until someone on an older build tries.
    const versions = JSON.parse(read("versions.json")) as Record<string, string>;
    expect(Object.keys(versions)).toContain(manifest.version);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("gives it a real heading in the changelog, not Unreleased", () => {
    // Between releases the manifest names the *last* released version, so its
    // heading must already exist. Anything still under Unreleased is work that
    // has not shipped, which is the correct state — it is only wrong when the
    // manifest claims a version the changelog has never heard of.
    expect(read("CHANGELOG.md")).toContain(`## [${manifest.version}]`);
  });

  it("says the same version in the README and on the documentation site", () => {
    // These are the two that drift, because nothing else depends on them.
    for (const path of ["README.md", "docs/index.md"]) {
      expect(read(path), `${path} does not mention version ${manifest.version}`).toContain(
        manifest.version,
      );
    }
  });

  it("does not leave a stale version behind in either", () => {
    // Catches the half-update: the download line bumped, the status line not.
    const [major, minor] = manifest.version.split(".");
    const previous = new RegExp(`\\b${major}\\.(?!${minor}\\b)\\d+\\.\\d+\\b`, "g");
    for (const path of ["README.md", "docs/index.md"]) {
      const stale = read(path).match(previous) ?? [];
      expect(stale, `${path} still mentions ${stale.join(", ")}`).toHaveLength(0);
    }
  });
});

describe("the install instructions match how the bundle is actually produced", () => {
  it("tells people the command that writes the zip", () => {
    // `npm run build` writes the three files but no zip; `package` does both.
    // Getting this wrong once meant a month-old zip sat in dist/ looking
    // current, which is the reason this assertion exists.
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts["package"]).toContain("scripts/package.mjs");
    expect(scripts["build"]).not.toContain("scripts/package.mjs");
    expect(read("README.md")).toContain("npm run package");
  });

  it("names the three files that are the whole plugin", () => {
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      expect(read("README.md")).toContain(file);
      expect(read("docs/index.md")).toContain(file);
    }
  });
});
