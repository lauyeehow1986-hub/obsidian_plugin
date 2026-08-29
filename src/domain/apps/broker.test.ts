import { describe, expect, it } from "vitest";

import {
  authoriseQuery,
  authoriseTarget,
  authoriseWrite,
  describeProposal,
  isAppRequest,
  PROTOCOL_VERSION,
} from "./broker";
import type { AppManifest } from "./manifest";

function app(query: string[], write: "none" | "propose" = "none"): AppManifest {
  return {
    path: "92 Apps/APP-x.md",
    id: "APP-x",
    title: "An app",
    description: "",
    capabilities: { query, write, network: false },
    export: "allowed",
    source: "",
    tagged: true,
    updated: "",
    problems: [],
  };
}

describe("messages from the frame are untrusted input (§5.13)", () => {
  it("accepts a well-formed request", () => {
    expect(isAppRequest({ scdb: PROTOCOL_VERSION, id: 1, kind: "query", payload: {} })).toBe(true);
  });

  it("rejects anything that is not the shape it claims", () => {
    expect(isAppRequest(null)).toBe(false);
    expect(isAppRequest("query")).toBe(false);
    expect(isAppRequest([])).toBe(false);
    expect(isAppRequest({ scdb: 99, id: 1, kind: "query" })).toBe(false);
    expect(isAppRequest({ scdb: PROTOCOL_VERSION, id: "1", kind: "query" })).toBe(false);
    expect(isAppRequest({ scdb: PROTOCOL_VERSION, id: 1, kind: "delete-everything" })).toBe(false);
    expect(isAppRequest({ scdb: PROTOCOL_VERSION, id: 1, kind: "query", payload: "all" })).toBe(
      false,
    );
  });
});

describe("what an app may read (§5.13)", () => {
  it("gives everything granted when the app asks for nothing in particular", () => {
    const allowed = authoriseQuery({}, app(["scdb-request", "run"]));
    expect(allowed).toEqual({ ok: true, value: ["scdb-request", "run"] });
  });

  it("allows a subset of what was granted", () => {
    expect(authoriseQuery({ types: ["run"] }, app(["scdb-request", "run"]))).toEqual({
      ok: true,
      value: ["run"],
    });
  });

  it("refuses a type outside the manifest, and names both sides", () => {
    const refused = authoriseQuery({ types: ["correspondence"] }, app(["scdb-request"]));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/granted scdb-request/);
    expect(refused.error).toMatch(/asked for correspondence/);
  });

  it("refuses an app granted nothing, and says how to change that", () => {
    const refused = authoriseQuery({ types: ["run"] }, app([]));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/capabilities\.query/);
  });
});

describe("what an app may propose (§5.13)", () => {
  it("refuses any write from an app granted write: none", () => {
    const refused = authoriseWrite({ path: "a.md", frontmatter: { x: 1 } }, app(["run"]));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/not granted write access/);
  });

  it("accepts a well-formed proposal from an app granted propose", () => {
    const allowed = authoriseWrite(
      { path: "10 Requests/REQ-1.md", frontmatter: { priority: "high" }, reason: "Overdue." },
      app(["scdb-request"], "propose"),
    );
    expect(allowed).toEqual({
      ok: true,
      value: {
        path: "10 Requests/REQ-1.md",
        frontmatter: { priority: "high" },
        reason: "Overdue.",
      },
    });
  });

  it("refuses a proposal that names no note or sets no field", () => {
    const manifest = app(["scdb-request"], "propose");
    expect(authoriseWrite({ frontmatter: { a: 1 } }, manifest).ok).toBe(false);
    expect(authoriseWrite({ path: "a.md", frontmatter: {} }, manifest).ok).toBe(false);
    expect(authoriseWrite({ path: "a.md" }, manifest).ok).toBe(false);
  });

  /**
   * The fields no manifest can unlock. `history` is what every dwell, bounce
   * and turnaround figure is computed from (§5.1) — corrupting it would not
   * break something visible, it would quietly change the numbers in a report.
   */
  it("refuses a proposal touching identity or history whatever the manifest says", () => {
    const manifest = app(["scdb-request"], "propose");
    for (const key of ["uid", "type", "history"]) {
      const refused = authoriseWrite(
        { path: "a.md", frontmatter: { [key]: "anything" } },
        manifest,
      );
      expect(refused.ok, key).toBe(false);
      if (refused.ok) continue;
      expect(refused.error).toMatch(key);
    }
  });

  it("refuses a dotted path into a protected field too", () => {
    const refused = authoriseWrite(
      { path: "a.md", frontmatter: { "history.0.to": "delivered" } },
      app(["scdb-request"], "propose"),
    );
    expect(refused.ok).toBe(false);
  });

  /** Otherwise one granted type plus `propose` would be write access to the vault. */
  it("refuses a target whose note type the app may not even read", () => {
    const refused = authoriseTarget("correspondence", app(["scdb-request"], "propose"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/only to the note types it may read/);
    expect(authoriseTarget("scdb-request", app(["scdb-request"], "propose")).ok).toBe(true);
  });
});

describe("describing a proposed change for the confirmation", () => {
  it("lists only the fields that actually move", () => {
    const changes = describeProposal(
      { path: "a.md", frontmatter: { priority: "high", stage: "triage" }, reason: "" },
      { priority: "normal", stage: "triage" },
    );
    expect(changes).toEqual([{ key: "priority", before: "normal", after: "high", added: false }]);
  });

  it("marks a field the note does not have yet", () => {
    const changes = describeProposal(
      { path: "a.md", frontmatter: { assignee: "[[B]]" }, reason: "" },
      {},
    );
    expect(changes[0]?.added).toBe(true);
  });

  it("returns nothing when the proposal would change nothing", () => {
    expect(
      describeProposal({ path: "a.md", frontmatter: { a: [1, 2] }, reason: "" }, { a: [1, 2] }),
    ).toEqual([]);
  });
});
