/**
 * Rule 3, enforced rather than described.
 *
 * *"Every outbound request goes through one gateway."* That is a claim about
 * the whole source tree, and a comment saying so is worth nothing the first
 * time somebody reaches for `fetch` because it was quicker. This test reads
 * every source file and fails if a second way out of the machine appears.
 *
 * It is deliberately blunt — a textual scan, not a type-aware one. A cleverer
 * check would be a check somebody could talk their way around; this one either
 * finds the word or it does not, and the fix is always the same: go through
 * `services/httpGateway`.
 *
 * The same argument as `domain/` being Obsidian-free: an architectural rule
 * that only exists in prose is an architectural rule that has already been
 * broken somewhere you have not looked yet.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The one module allowed to open a connection, and the one test about it. */
const GATEWAY = "src/services/httpGateway.ts";

const SOURCE_ROOT = "src";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(path.split("\\").join("/"));
    }
  }
  return found;
}

/**
 * Strip comments before scanning.
 *
 * Every one of these words appears in the prose of this codebase — the
 * gateway's own docblock explains why it does not use `requestUrl`. A scan
 * that read comments would either fail on documentation or force the
 * documentation to stop naming the thing it is explaining.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("only one module can reach a network (rule 3)", () => {
  const files = sourceFiles(SOURCE_ROOT);

  it("finds the source tree at all", () => {
    // Guards against the scan silently passing because it read nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(GATEWAY);
  });

  it.each([
    ["fetch(", /(?<![.\w])fetch\s*\(/],
    ["XMLHttpRequest", /XMLHttpRequest/],
    ["WebSocket", /\bnew\s+WebSocket\b/],
    ["EventSource", /\bnew\s+EventSource\b/],
    ["navigator.sendBeacon", /sendBeacon/],
    ["Obsidian's requestUrl", /\brequestUrl\b/],
    ["node:http / node:https", /require\(\s*["'](node:)?https?["']\s*\)/],
    ["node:net / node:dgram", /require\(\s*["'](node:)?(net|dgram|tls)["']\s*\)/],
  ])("no module outside the gateway uses %s", (_label, pattern) => {
    const offenders = files.filter((path) => {
      if (path === GATEWAY) return false;
      // The fixture module is captured API responses, not a caller.
      if (path.endsWith(".fixture.ts")) return false;
      return pattern.test(code(readFileSync(path, "utf8")));
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the gateway small enough to read in one sitting", () => {
    // The argument `services/protocol` makes about itself: the module where a
    // mistake becomes an outward action earns its scrutiny by staying short.
    //
    // **Counted without comments, deliberately.** The first version counted
    // every line and tripped when a comment was *improved* — which would have
    // taught the wrong lesson, since the explanation of why this module exists
    // is the part a reviewer most needs. What has to stay small is the code
    // somebody must read to convince themselves nothing else gets out.
    const lines = code(readFileSync(GATEWAY, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeLessThan(240);
  });

  it("never lets a host reach the gateway from settings", () => {
    // The allowlist is a constant in domain/sources/gateway. If a host ever
    // becomes configurable, rule 3's guarantee is gone and this fails.
    const schema = readFileSync("src/domain/settings/schema.ts", "utf8");
    expect(code(schema)).not.toMatch(/\bhosts?\s*[?]?\s*:\s*(string|readonly|Array)/);
  });

  it("declares exactly the hosts the sources need, and no more", () => {
    // **This test is meant to fail when a host is added.** That is the whole
    // design: the allowlist is a constant in code precisely so that widening it
    // cannot happen quietly, and a red test in the diff is what makes a
    // reviewer look at the new name. Update the list here only in the same
    // change that adds the source, the settings switch and the changelog entry.
    const gateway = readFileSync("src/domain/sources/gateway.ts", "utf8");
    const hosts = [...code(gateway).matchAll(/host:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(hosts).toEqual([
      "eutils.ncbi.nlm.nih.gov",
      "clinicaltrials.gov",
      // Added for cardiac guideline feeds. `domain/sources/guidelines` records
      // which societies were probed, and which two publish nothing readable.
      "www.eacts.org",
      "www.escardio.org",
    ]);
  });
});
