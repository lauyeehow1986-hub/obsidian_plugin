/**
 * The shipped fixtures are parsed by the real parsers, not by eye.
 *
 * `test-vault/` is documentation as much as it is a test fixture: it is the
 * worked example of the vault contract (CLAUDE.md §5), and the first thing a
 * second maintainer reads. A fixture that has quietly drifted out of the
 * contract teaches the wrong thing and hides a regression, so every note and
 * every workflow spec in it is run through the parser the plugin actually uses.
 *
 * Why js-yaml specifically, as a devDependency: Obsidian's `parseYaml` IS
 * js-yaml v4 — the shipped app bundle carries its `renamed("safeLoad","load")`
 * v4 deprecation shim. Matching the library and the major is the whole point.
 * A hand-rolled YAML subset parser would be worse than no guard here: it would
 * eventually accept a fixture Obsidian rejects, which is false confidence.
 * It costs zero bundle bytes — nothing under `src/` imports it, so esbuild
 * never sees it.
 *
 * Note the one real divergence the design already anticipates: unquoted
 * `received: 2026-07-14` loads as a `Date` under YAML's default schema, while
 * Obsidian's metadata cache may hand over a string. `parseTimestamp`
 * (domain/time/dates.ts) takes both, deliberately.
 */

import { load } from "js-yaml";
import { agedOutreach, CORRESPONDENCE_TYPE, parseThread } from "../src/domain/comms/thread";
import { CAPTURE_TYPE } from "../src/domain/capture/capture";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { deadlines } from "../src/domain/overview/overview";
import { parsePublication, PUBLICATION_TYPE } from "../src/domain/publication/publication";
import { validateQuery } from "../src/domain/query/model";
import { parseSavedView, VIEW_TYPE } from "../src/domain/query/savedView";
import { REQUEST_FIELDS, REQUEST_ROW_TYPE } from "../src/domain/request/queryFields";
import { parseRequest } from "../src/domain/request/request";
import {
  isKnownStage,
  parseWorkflowSpec,
  type WorkflowSpec,
} from "../src/domain/request/workflow";

const VAULT = join(__dirname, "..", "test-vault");

/**
 * Stages no fixture can resolve, and must not be able to.
 *
 * `REQ-2026-008` is the migration view's hard path: a stage that was removed
 * without a `retired:` mapping, so it can only move by a human choosing a
 * target and typing a reason (§5.2). If a mapping is ever added for it, this
 * list should fail — the fixture would have stopped testing anything.
 */
const DELIBERATELY_STRANDED: ReadonlyArray<[string, string]> = [["REQ-2026-008", "scoping"]];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue; // .obsidian holds app state, not notes
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Split a note the way Obsidian does: a `---` fence on the very first line. */
function frontmatterOf(source: string): string | null {
  const normalised = source.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return null;
  const end = normalised.indexOf("\n---", 3);
  return end === -1 ? null : normalised.slice(4, end + 1);
}

function loadRecord(yaml: string, where: string): Record<string, unknown> {
  const raw = load(yaml);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: frontmatter is not a mapping.`);
  }
  return raw as Record<string, unknown>;
}

const files = walk(VAULT).map((path) => ({
  rel: relative(VAULT, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

const specs = new Map<string, WorkflowSpec>();
const notes: Array<{ rel: string; front: Record<string, unknown> }> = [];

for (const file of files) {
  if (/^_config\/workflows\/.+\.ya?ml$/.test(file.rel)) {
    const parsed = parseWorkflowSpec(load(file.text));
    if (parsed.spec) specs.set(parsed.spec.id, parsed.spec);
    continue;
  }
  if (!file.rel.endsWith(".md")) continue;
  const yaml = frontmatterOf(file.text);
  if (yaml === null) continue; // README and prose notes carry no frontmatter
  notes.push({ rel: file.rel, front: loadRecord(yaml, file.rel) });
}

const typed = (type: string) => notes.filter((note) => note.front["type"] === type);

describe("the test vault is discoverable at all", () => {
  it("found notes and specs — an empty sweep is not a passing guard", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(notes.length).toBeGreaterThan(0);
    expect(specs.size).toBeGreaterThan(0);
    expect(typed(REQUEST_ROW_TYPE).length).toBeGreaterThan(0);
    expect(typed(VIEW_TYPE).length).toBeGreaterThan(0);
  });

  it("gives every note a type, because type is what every view selects on", () => {
    // `_config/` is configuration, not content. A workflow spec is YAML and a
    // message template is markdown the composer reads by path, and neither is
    // a note the index should be selecting on — a `type:` there would put the
    // plugin's own plumbing into the user's Explore board.
    const untyped = notes.filter(
      (note) => typeof note.front["type"] !== "string" && !note.rel.startsWith("_config/"),
    );
    expect(untyped.map((note) => note.rel)).toEqual([]);
  });
});

describe("workflow specs", () => {
  const yamls = files.filter((file) => /^_config\/workflows\/.+\.ya?ml$/.test(file.rel));

  it.each(yamls.map((file) => file.rel))("%s parses with no errors", (rel) => {
    const file = yamls.find((entry) => entry.rel === rel);
    const parsed = parseWorkflowSpec(load(file!.text));
    const errors = parsed.problems.filter((problem) => problem.severity === "error");
    expect(errors.map((problem) => `${problem.at}: ${problem.message}`)).toEqual([]);
    expect(parsed.spec).not.toBeNull();
  });
});

describe("request notes", () => {
  const requests = typed(REQUEST_ROW_TYPE);

  it.each(requests.map((note) => note.rel))("%s parses with no problems", (rel) => {
    const note = requests.find((entry) => entry.rel === rel);
    expect(parseRequest(note!.front).problems).toEqual([]);
  });

  it("names a workflow spec that exists", () => {
    const dangling = requests
      .map((note) => ({ rel: note.rel, workflow: parseRequest(note.front).request.workflow }))
      .filter((entry) => !specs.has(entry.workflow));
    expect(dangling).toEqual([]);
  });

  it("sits on a stage that resolves, or is stranded on purpose", () => {
    const unresolved: Array<[string, string]> = [];
    for (const note of requests) {
      const { request } = parseRequest(note.front);
      const spec = specs.get(request.workflow);
      if (!spec) continue; // reported by the test above
      const resolves = isKnownStage(spec, request.stage) || request.stage in spec.retired;
      if (!resolves) unresolved.push([request.id, request.stage]);
    }
    expect(unresolved.sort()).toEqual([...DELIBERATELY_STRANDED].sort());
  });

  it("keeps a fixture on a retired stage, so auto-mapping stays exercised", () => {
    const onRetired = requests.filter((note) => {
      const { request } = parseRequest(note.front);
      const spec = specs.get(request.workflow);
      return spec !== undefined && request.stage in spec.retired;
    });
    expect(onRetired.length).toBeGreaterThan(0);
  });
});

describe("publication notes", () => {
  const publications = typed(PUBLICATION_TYPE);

  it("ships at least one, so the overview's third list is exercised", () => {
    expect(publications.length).toBeGreaterThan(0);
  });

  it.each(publications.map((note) => note.rel))("%s parses with no problems", (rel) => {
    const note = publications.find((entry) => entry.rel === rel);
    expect(parsePublication(rel, note!.front).problems).toEqual([]);
  });
});

describe("obligation notes", () => {
  const obligations = typed("obligation");

  it("ships one with a date and one without, covering both overview paths", () => {
    // §5.7: an obligation the scheduler cannot place must be *reported* as
    // unscheduled, never dropped — so a fixture has to exist for that path.
    const dated = deadlines(
      obligations.map((note) => ({ path: note.rel, type: "obligation", frontmatter: note.front })),
      { now: Date.parse("2026-08-22T00:00:00Z"), withinDays: 3650 },
    );
    expect(dated.due.length).toBeGreaterThan(0);
    expect(dated.unscheduled.length).toBeGreaterThan(0);
  });

  it("says what breaks, because a reminder that does not is ignored (§5.7)", () => {
    const silent = obligations.filter(
      (note) => typeof note.front["consequence"] !== "string" || note.front["consequence"] === "",
    );
    expect(silent.map((note) => note.rel)).toEqual([]);
  });
});

describe("saved views", () => {
  const views = typed(VIEW_TYPE);

  it.each(views.map((note) => note.rel))("%s parses with no problems", (rel) => {
    const note = views.find((entry) => entry.rel === rel);
    expect(parseSavedView(note!.front).problems).toEqual([]);
  });

  it.each(views.map((note) => note.rel))("%s names only fields that exist", (rel) => {
    const note = views.find((entry) => entry.rel === rel);
    const { view } = parseSavedView(note!.front);
    // Every shipped view queries requests; extend the catalogue here when one
    // targets a type that has its own declared fields.
    expect(view.query.types).toEqual([REQUEST_ROW_TYPE]);
    expect(validateQuery(view.query, REQUEST_FIELDS)).toEqual([]);
  });
});

describe("correspondence threads", () => {
  const threads = typed(CORRESPONDENCE_TYPE);
  const NOW = Date.parse("2026-08-23T09:00:00Z");

  const parsed = () =>
    threads.map((note) => ({
      rel: note.rel,
      ...parseThread(note.front, note.rel.split("/").pop()!.replace(/\.md$/, "")),
    }));

  it.each(threads.map((note) => note.rel))("%s parses with no problems", (rel) => {
    expect(parsed().find((entry) => entry.rel === rel)!.problems).toEqual([]);
  });

  it("ships one that ages and one that must not", () => {
    // Both halves matter. Without the answered thread the ageing filter could
    // be returning everything and the fixture would still look right.
    const aged = agedOutreach(
      parsed().map((entry) => entry.thread),
      { now: NOW },
    );
    expect(aged.length).toBe(1);
    expect(threads.length).toBeGreaterThan(1);
  });

  it("records every outbound message as composed, never as sent (§5.11 rule 6)", () => {
    for (const entry of parsed()) {
      for (const message of entry.thread.messages) {
        if (message.dir !== "outbound") continue;
        expect(message.composedOnly, `${entry.rel} ${message.summary}`).toBe(true);
      }
    }
  });

  it("stores a summary per message and never a body", () => {
    // A thread note is read back into briefings and exports; a message body in
    // there is content that would travel with them (rule 7).
    for (const note of threads) {
      for (const message of (note.front["messages"] as Record<string, unknown>[]) ?? []) {
        expect(Object.keys(message)).not.toContain("body");
        expect(typeof message["summary"]).toBe("string");
      }
    }
  });

  it("names people who have a note in the vault", () => {
    const basenames = new Set(
      notes.map((note) => note.rel.split("/").pop()!.replace(/\.md$/, "").toLowerCase()),
    );
    for (const entry of parsed()) {
      for (const party of entry.thread.with) {
        expect(basenames.has(party.name.toLowerCase()), `${entry.rel} → ${party.name}`).toBe(true);
      }
    }
  });
});

describe("person notes", () => {
  const people = typed("person");

  it("ships one with an address and one without", () => {
    // The composer must cope with a person it cannot address — the To field
    // opens empty rather than guessing. A wrong address on a chase-up about a
    // data request is a disclosure, not a typo.
    const withEmail = people.filter((note) => typeof note.front["email"] === "string");
    expect(withEmail.length).toBeGreaterThan(0);
    expect(people.length).toBeGreaterThan(withEmail.length);
  });

  it("uses only reserved example addresses, so a mis-click reaches nobody", () => {
    // RFC 2606 reserves example.com for exactly this. Rule 1: nothing real
    // enters a public repository, and an address is something real.
    const outside = people
      .map((note) => note.front["email"])
      .filter((email): email is string => typeof email === "string")
      .filter((email) => !/@(example\.(com|org|net)|.*\.example)$/.test(email));
    expect(outside).toEqual([]);
  });
});

describe("captures", () => {
  it("ships one, untriaged, so the inbox path is exercised", () => {
    const captures = typed(CAPTURE_TYPE);
    expect(captures.length).toBeGreaterThan(0);
    for (const note of captures) {
      expect(note.rel.startsWith("00 Inbox/")).toBe(true);
      // Explicitly false rather than absent: "what is still untriaged" must be
      // answerable without inferring from a missing key.
      expect(note.front["triaged"]).toBe(false);
      expect(typeof note.front["mode"]).toBe("string");
    }
  });
});
