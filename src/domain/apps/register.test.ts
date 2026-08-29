import { describe, expect, it } from "vitest";

import { newGrant, type AppGrant } from "./grant";
import { parseManifest, type AppManifest } from "./manifest";
import { buildRegister, searchApps, summarise } from "./register";

function manifest(
  id: string,
  query: string[],
  options: { write?: "none" | "propose"; body?: string; title?: string } = {},
): AppManifest {
  return parseManifest({
    path: `92 Apps/${id}.md`,
    frontmatter: {
      id,
      title: options.title ?? id,
      capabilities: { query, write: options.write ?? "none" },
    },
    body: options.body ?? "```js app\nmount(A);\n```",
  });
}

const GRANTS: Record<string, AppGrant> = {
  "APP-ready": newGrant({ query: ["run"], write: "none", network: false }, "2026-08-29"),
  "APP-changed": newGrant({ query: ["run"], write: "none", network: false }, "2026-08-29"),
};

describe("the apps register (§5.13)", () => {
  const register = buildRegister(
    [
      manifest("APP-ready", ["run"]),
      manifest("APP-consent", ["run"]),
      manifest("APP-changed", ["run", "correspondence"]),
      manifest("APP-broken", ["run"], { body: "# No code here" }),
    ],
    GRANTS,
  );

  it("puts what needs a decision from you first", () => {
    expect(register.map((entry) => entry.manifest.id)).toEqual([
      "APP-broken",
      "APP-changed",
      "APP-consent",
      "APP-ready",
    ]);
  });

  /**
   * An app you wrote is expected to ask on first run; one you already trusted
   * now asking for more is the case the grant hash exists for, and it should
   * not sit below three apps you simply have not opened yet.
   */
  it("ranks a widened manifest above one that has never been run", () => {
    const states = register.map((entry) => entry.state);
    expect(states.indexOf("changed")).toBeLessThan(states.indexOf("consent"));
  });

  it("marks everything that cannot run without a decision", () => {
    const byId = Object.fromEntries(register.map((entry) => [entry.manifest.id, entry]));
    expect(byId["APP-ready"]?.needsConsent).toBe(false);
    expect(byId["APP-consent"]?.needsConsent).toBe(true);
    expect(byId["APP-changed"]?.needsConsent).toBe(true);
  });

  it("counts what the board's header says", () => {
    expect(summarise(register)).toEqual({ total: 4, ready: 1, awaiting: 2, broken: 1 });
  });

  it("finds an app by what it reads, not only by its name", () => {
    expect(searchApps(register, "correspondence").map((entry) => entry.manifest.id)).toEqual([
      "APP-changed",
    ]);
    expect(searchApps(register, "").length).toBe(4);
  });

  it("shows what each app may reach", () => {
    const ready = register.find((entry) => entry.manifest.id === "APP-ready");
    expect(ready?.capabilities).toBe("reads run · cannot write · no network");
  });
});
