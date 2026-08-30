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
import { parseLaunchTargets } from "../src/domain/launch/target";
import { agedOutreach, CORRESPONDENCE_TYPE, parseThread } from "../src/domain/comms/thread";
import { parseEml } from "../src/domain/comms/eml";
import {
  alreadyRecorded,
  newThreadFromEml,
  planMessage,
  threadForMessage,
  type PlanOptions,
} from "../src/domain/comms/emlThread";
import { CAPTURE_TYPE } from "../src/domain/capture/capture";
import { VARIABLE_TYPE, parseVariable } from "../src/domain/catalogue/variable";
import { noteCitations } from "../src/domain/catalogue/dependants";
import { buildCatalogue } from "../src/domain/catalogue/register";
import { definitionInForceOn } from "../src/domain/catalogue/lineage";
import { SCRIPT_DOC_TYPE, parseScriptDoc } from "../src/domain/script/scriptDoc";
import { RUN_TYPE, parseRunRecord } from "../src/domain/script/runRecord";
import { buildScriptRegister } from "../src/domain/script/register";
import { REDCAP_FORM_TYPE } from "../src/domain/redcap/field";
import { findBlock } from "../src/domain/redcap/block";
import { parseFormSpec } from "../src/domain/redcap/form";
import { buildRegister as buildFormsRegister } from "../src/domain/redcap/register";
import { VAULT_APP_TYPE, parseManifest } from "../src/domain/apps/manifest";
import { buildRegister as buildAppsRegister, summarise as summariseApps } from "../src/domain/apps/register";
import { newGrant } from "../src/domain/apps/grant";
import { buildFrame } from "../src/domain/apps/frame";
import { findRunnableBlocks } from "../src/domain/compute/block";
import {
  fromDictionaryCsv,
  instrumentsToBlock,
  toDictionaryCsv,
} from "../src/domain/redcap/dictionary";
import { STUDY_TYPE, parseStudy } from "../src/domain/study/study";
import { PROJECT_TYPE } from "../src/domain/project/create";
import { parseProject } from "../src/domain/project/project";
import { buildPortfolio } from "../src/domain/project/portfolio";
import { milestoneEvents } from "../src/domain/project/schedule";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { deadlines } from "../src/domain/overview/overview";
import { parseEventNote } from "../src/domain/events/event";
import { buildSchedule, occurrenceDate } from "../src/domain/events/schedule";
import { calendarEvents } from "../src/domain/events/feed";
import { buildCalendar, parseCalendar } from "../src/domain/events/ics";
import { parsePublication, PUBLICATION_TYPE } from "../src/domain/publication/publication";
import { DIAGRAM_NOTE_TYPE, parseDiagram } from "../src/domain/diagram/diagram";
import { toMermaid, toMermaidBlock } from "../src/domain/diagram/mermaid";
import { diffPolicy } from "../src/domain/policy/diff";
import { buildImpactMap } from "../src/domain/policy/impact";
import {
  noteDependencyEdges,
  parsePolicy,
  POLICY_TYPE,
  refMatchesPolicy,
} from "../src/domain/policy/policy";
import { buildRegister, indexIncoming } from "../src/domain/policy/register";
import { BUILT_IN_TEMPLATES } from "../src/domain/report/builtins";
import { parseTemplate, templateToPlain } from "../src/domain/report/template";
import { composeCv, cvLine } from "../src/domain/profile/cv";
import { parseProfileNote, PROFILE_TYPES } from "../src/domain/profile/profile";
import { scanMinutes } from "../src/domain/extract/minutes";
import { planExtraction, recordFor } from "../src/domain/extract/plan";
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

/** Everything on disk, committed or not. The safety scans use this. */
const onDisk = walk(VAULT).map((path) => ({
  rel: relative(VAULT, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

/**
 * The committed fixture set — what a fresh clone actually gets.
 *
 * Working in the test vault *generates* notes: composing a chase-up opens a
 * correspondence thread, the briefing writes a note, the ledger appends a
 * month file. Those are gitignored output, not worked examples of the
 * contract, and a shape assertion that counts them ("exactly one thread ages")
 * goes red the first time somebody uses the plugin they are developing. So the
 * fixture set is what git tracks, and git is the authority on that.
 *
 * The *content* guards below deliberately do not use this — see `onDisk`.
 */
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z", "--", "test-vault"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  })
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^test-vault\//, "")),
);

if (tracked.size === 0) {
  // Loudly, rather than silently falling back to the full walk: an empty
  // fixture set would make every assertion below vacuously pass.
  throw new Error("git ls-files returned no test-vault fixtures — is this a git checkout?");
}

const files = onDisk.filter((file) => tracked.has(file.rel));

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

describe("projects", () => {
  // §5.15's note type, run through the real parser. The fixtures are also the
  // worked example of what a project note looks like, so a `blocked_by` typo
  // or a milestone with no id has to fail here rather than teach the wrong
  // shape to whoever copies one.
  const parsed = typed(PROJECT_TYPE).map((note) => ({
    rel: note.rel,
    ...parseProject(note.front),
  }));

  it("ships some, so the portfolio board has something to show", () => {
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("reads every one with no problems at all", () => {
    for (const entry of parsed) {
      expect({ rel: entry.rel, problems: entry.problems }).toEqual({
        rel: entry.rel,
        problems: [],
      });
    }
  });

  it("puts every project in a stage its own workflow spec declares", () => {
    const specs = files
      .filter((file) => /^_config\/workflows\/.+\.ya?ml$/.test(file.rel))
      .map((file) => parseWorkflowSpec(load(file.text)).spec)
      .filter((spec): spec is NonNullable<typeof spec> => spec !== null);

    for (const entry of parsed) {
      const spec = specs.find((candidate) => candidate.id === entry.project.workflow);
      expect({ rel: entry.rel, spec: spec?.id ?? null }).toEqual({
        rel: entry.rel,
        spec: entry.project.workflow,
      });
      expect({
        rel: entry.rel,
        known: spec!.stages.some((stage) => stage.id === entry.project.stage),
      }).toEqual({ rel: entry.rel, known: true });
    }
  });

  it("covers both halves of the board: something overdue and something quiet", () => {
    // A fixture set where nothing is late exercises none of the colour, the
    // ordering or the totals. One of each is the minimum that proves the board.
    const spec = files
      .filter((file) => /^_config\/workflows\/project\.ya?ml$/.test(file.rel))
      .map((file) => parseWorkflowSpec(load(file.text)).spec)[0];
    const board = buildPortfolio(
      parsed.map((entry) => entry.project),
      spec ?? null,
      [],
      { now: Date.parse("2026-08-30T12:00:00Z") },
    );
    expect(board.stranded).toEqual([]);
    expect(board.totals.overdueMilestones).toBeGreaterThan(0);
    expect(board.totals.blockedMilestones).toBeGreaterThan(0);
  });

  it("puts its dated milestones on the one schedule", () => {
    // §5.15: milestones reach the deadline board through the event engine.
    // If this ever returns nothing, the projection has been disconnected.
    const events = milestoneEvents(
      parsed.map((entry) => ({ project: entry.project, path: entry.rel })),
    );
    expect(events.length).toBeGreaterThan(0);
    const schedule = buildSchedule(events, {
      today: "2026-08-30",
      horizonDays: 365,
      defaultLeadDays: [30, 7, 1],
    });
    expect(schedule.some((occurrence) => occurrence.date !== "")).toBe(true);
  });
});

describe("launch targets", () => {
  // The committed file is documentation as much as fixture: it is the worked
  // example of what a launcher config looks like, and an example that does not
  // parse teaches the wrong shape. Checking the *problems* rather than just
  // "it loaded" is the point — a target with an error is dropped silently by
  // design, so a broken example would otherwise show up as an empty list.
  const yamls = files.filter((file) => /^_config\/launchers\.ya?ml$/.test(file.rel));

  it("ships one", () => {
    expect(yamls.map((file) => file.rel)).toEqual(["_config/launchers.yaml"]);
  });

  it.each(yamls.map((file) => file.rel))("%s parses with no problems at all", (rel) => {
    const file = yamls.find((entry) => entry.rel === rel);
    const parsed = parseLaunchTargets(load(file!.text));
    expect(parsed.problems.map((problem) => `${problem.at}: ${problem.message}`)).toEqual([]);
    expect(parsed.targets.map((target) => target.kind)).toEqual(["url", "file", "folder"]);
  });
});

describe("report templates", () => {
  // These five are committed as worked examples: `_config/reports/` is the
  // first file anyone edits, and the block vocabulary is otherwise documented
  // only in the source of a plugin the work laptop cannot build.
  //
  // The risk a committed copy carries is drift — a built-in changed in code
  // while the example in the vault quietly teaches the old shape. So the guard
  // is equality with the built-in, not merely "it parses": change a template in
  // `builtins.ts` and this goes red until the example is written out again.
  const yamls = files.filter((file) => /^_config\/reports\/.+\.ya?ml$/.test(file.rel));

  it("ships one worked example per built-in template", () => {
    expect(yamls.map((file) => file.rel).sort()).toEqual(
      BUILT_IN_TEMPLATES.map((template) => `_config/reports/${template.id}.yaml`).sort(),
    );
  });

  it.each(yamls.map((file) => file.rel))("%s is the built-in, exactly", (rel) => {
    const file = yamls.find((entry) => entry.rel === rel);
    const parsed = parseTemplate(load(file!.text), rel);
    expect(parsed.problems).toEqual([]);
    expect(parsed.template).not.toBeNull();

    const builtIn = BUILT_IN_TEMPLATES.find(
      (template) => template.id === parsed.template?.id,
    );
    expect(builtIn).toBeDefined();
    expect(templateToPlain(parsed.template!)).toEqual(templateToPlain(builtIn!));
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

/**
 * The minutes fixture, through the real extractor (§7 B6).
 *
 * This one matters more than most. The fixture *is* the documentation of what
 * a marker looks like — the shape a user is being told to write minutes in —
 * so an assertion here is the only thing stopping the example and the parser
 * drifting apart, at which point the plugin teaches a syntax it no longer
 * reads.
 */
describe("the minutes fixture (§7 B6)", () => {
  const rel = "70 Meetings/2026-08-19 SCDB operations.md";
  const file = files.find((entry) => entry.rel === rel);

  it("is committed, or every assertion below passes vacuously", () => {
    expect(file).toBeDefined();
  });

  const scan = scanMinutes({
    content: file?.text ?? "",
    anchor: "2026-08-19",
    people: ["Dr Fictional Example", "Example Coordinator", "Prof Invented Approver"],
  });

  it("reads every marker style the fixture demonstrates", () => {
    expect(scan.items.map((item) => [item.kind, item.text])).toEqual([
      ["action", "countersign the outstanding DUA"],
      ["action", "re-run the readmission extraction"],
      ["action", "confirm whether the continuing review letter has been filed"],
      ["action", "Draft the chase-up cadence note for the next meeting"],
      ["decision", "the QC step stays in the workflow for identifiable extractions"],
      ["decision", "requests unreconciled for more than 60 days are raised at this meeting"],
      ["deadline", "annual facility report"],
      ["deadline", "the audit sample is picked on 03/04/2026"],
    ]);
  });

  it("resolves owners three ways and invents nobody", () => {
    expect(scan.items.map((item) => item.owner?.name ?? null)).toEqual([
      "Dr Fictional Example", // a wikilink the writer typed
      "Example Coordinator", // a surname, matched against 30 People/
      "Prof Invented Approver", // an @handle, matched on initials
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(scan.items.flatMap((item) => item.problems).filter((p) => /no note for/.test(p.message))).toEqual(
      [],
    );
  });

  it("resolves dates against the meeting, and refuses the ambiguous one", () => {
    expect(scan.items.map((item) => item.due?.date ?? null)).toEqual([
      "2026-08-21", // "by Friday", from a Wednesday meeting
      "2026-09-15", // written out in full
      null,
      null,
      null,
      null,
      "2026-08-31", // "end of the month"
      null, // 03/04/2026 — refused, deliberately
    ]);
    expect(scan.items[7]?.problems[0]?.message).toMatch(/day-first or month-first/);
  });

  it("leaves the ticked checkbox alone and skips the line that records nothing", () => {
    expect(scan.done).toBe(1);
    expect(scan.items.map((item) => item.text)).not.toContain("none");
  });

  it("sends dated items to events and undated ones to the inbox", () => {
    const plan = planExtraction(scan.items, new Set(scan.items.map((item) => item.key)), []);
    expect(plan.writes.map((write) => write.destination)).toEqual([
      "event",
      "event",
      "capture",
      "capture",
      "decision",
      "decision",
      "event",
      "capture",
    ]);
  });

  it("is idempotent: a second run over an unedited note plans nothing", () => {
    const first = planExtraction(scan.items, new Set(scan.items.map((item) => item.key)), []);
    const recorded = first.writes.map((write) => recordFor(write, "", 0));
    const second = planExtraction(scan.items, new Set(scan.items.map((item) => item.key)), recorded);
    expect(second.writes).toEqual([]);
    expect(second.duplicates).toHaveLength(scan.items.length);
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

describe("policy notes (§5.14, §7 C1)", () => {
  const policyNotes = typed(POLICY_TYPE);
  const parsed = policyNotes.map((note) => parsePolicy(`40 Policies/${note.rel.split("/").pop()}`, note.front));

  it("ships at least one, so the register has something to report on", () => {
    expect(policyNotes.length).toBeGreaterThan(0);
  });

  it.each(policyNotes.map((note) => note.rel))("%s parses with no problems", (rel) => {
    const note = policyNotes.find((entry) => entry.rel === rel);
    expect(parsePolicy(rel, note!.front).problems).toEqual([]);
  });

  it("ships a dependency declared from the far end, not only from the policy", () => {
    // The SOP names which clauses of POL-DATA-REL-02 it rests on; the policy
    // note does not list the SOP. If this ever passes by accident because
    // somebody added it to `governs:` as well, the fixture stops testing the
    // direction it exists for.
    const target = parsed.find((policy) => policy.id === "POL-DATA-REL-02");
    expect(target?.governs.some((edge) => edge.label.startsWith("SOP-"))).toBe(false);

    const edges = policyNotes.flatMap((note) =>
      noteDependencyEdges(note.rel, POLICY_TYPE, note.front),
    );
    const incoming = indexIncoming(parsed, edges, refMatchesPolicy);
    expect(incoming.get(target!.path)?.map((edge) => edge.clause).sort()).toEqual(["5.1", "5.4"]);
  });

  it("reports the findings the bare fixture exists for", () => {
    const register = buildRegister({ policies: parsed, now: Date.parse("2026-08-24") });
    const bare = register.rows.find((row) => row.policy.id === "POL-RETENTION-01");
    expect(bare?.edges).toEqual([]);
    expect(bare?.frozen).toBe(0);
    expect(bare?.reviewState).toBe("unset");
    expect(register.summary.undeclared).toBeGreaterThan(0);
  });

  it("the reissued document in `_incoming/` produces every verdict", () => {
    // The point of shipping the inputs rather than a frozen copy: a fresh
    // clone can run the whole feature, and this proves the fixture actually
    // exercises all four outcomes rather than three and a hope.
    const live = files.find((file) => file.rel === "40 Policies/POL-DATA-REL-02.md");
    const incoming = files.find((file) => file.rel === "40 Policies/_incoming/POL-DATA-REL-02 v4.md");
    expect(live).toBeDefined();
    expect(incoming).toBeDefined();

    const policy = parsed.find((entry) => entry.id === "POL-DATA-REL-02")!;
    const edges = policyNotes.flatMap((note) =>
      noteDependencyEdges(note.rel, POLICY_TYPE, note.front),
    );
    const map = buildImpactMap({
      policy,
      diff: diffPolicy(live!.text, incoming!.text),
      incoming: indexIncoming(parsed, edges, refMatchesPolicy).get(policy.path) ?? [],
    });

    expect(map.counts).toEqual({ "clause-gone": 1, affected: 1, review: 1, clear: 1 });
  });
});

describe("catalogue variables (§5.8, §7 C2)", () => {
  const variables = typed(VARIABLE_TYPE).map((note) => parseVariable(note.rel, note.front));
  const citations = notes.flatMap((note) =>
    noteCitations(note.rel, String(note.front["type"] ?? ""), note.front),
  );

  it("ships a catalogue, so the board has something to open", () => {
    expect(variables.length).toBeGreaterThan(0);
  });

  it("carries exactly the findings the fixtures are there to demonstrate", () => {
    // Pinned rather than asserted loosely: these fixtures exist to make each
    // finding fire against real notes, and one quietly disappearing would take
    // the only end-to-end exercise of that code path with it.
    const catalogue = buildCatalogue({ variables, citations });
    expect(catalogue.summary).toMatchObject({
      identifiers: 1,
      unjustified: 1,
      // Two, since C3: the script doc cites VAR-EJECTION@2 and so does the run
      // record that executed it. Both are real findings and both should be
      // listed — the script is the thing to fix, and the run is the evidence
      // that a delivered output rests on the superseded definition.
      stale: 2,
      orphans: 1,
    });
  });

  it("has one variable with a real chain and one deliberately without", () => {
    const chained = variables.find((variable) => variable.id === "VAR-EJECTION")!;
    expect(chained.history.map((record) => record.version)).toEqual([1, 2]);

    const stranded = variables.find((variable) => variable.id === "VAR-INDEX-DATE")!;
    expect(stranded.history).toEqual([]);
  });

  it("answers what the chained variable meant before its current version", () => {
    const chained = variables.find((variable) => variable.id === "VAR-EJECTION")!;
    const answer = definitionInForceOn(chained, Date.parse("2020-06-01T12:00:00Z"));
    expect(answer.version).toBe(1);
    // Version 1 never recorded units, and today's "%" must not be borrowed
    // backwards to fill the gap.
    expect(answer.definition.units).toBeNull();
  });

  it("keeps every fixture parsing clean apart from the one staged field finding", () => {
    for (const variable of variables) {
      const staged = variable.id === "VAR-CASE-REF"; // identifier with no justification
      expect({ id: variable.id, clean: variable.problems.length === 0 }).toEqual({
        id: variable.id,
        clean: !staged,
      });
    }
  });

  it("puts the stranded version's finding on the chain, not on the fields", () => {
    // The two are deliberately separate: `parseVariable` judges the note's
    // fields, `chainProblems` judges the shape of its history. VAR-INDEX-DATE
    // is a well-formed note whose *chain* lost its previous definition, and
    // reporting that as a field problem would blur the distinction.
    const catalogue = buildCatalogue({ variables, citations });
    const row = catalogue.rows.find((entry) => entry.variable.id === "VAR-INDEX-DATE")!;
    expect(row.variable.problems).toEqual([]);
    expect(row.chain.join(" ")).toContain("only the version number survives");
  });
});

describe("script documentation and provenance (§5.12, §5.14, §7 C3)", () => {
  const docs = typed(SCRIPT_DOC_TYPE).map((note) => parseScriptDoc(note.rel, note.front));
  const runs = typed(RUN_TYPE).map((note) => parseRunRecord(note.rel, note.front));
  const variables = typed(VARIABLE_TYPE).map((note) => parseVariable(note.rel, note.front));
  const register = buildScriptRegister({ docs, runs, variables });

  it("ships scripts and runs, so the board has something to open", () => {
    expect(docs.length).toBeGreaterThan(0);
    expect(runs.length).toBeGreaterThan(0);
  });

  it("demonstrates every verdict the register can reach", () => {
    // Pinned deliberately: each fixture exists to make one finding fire against
    // a real note, and a board that only ever shows one group teaches nothing
    // about what the others mean.
    const byVerdict = Object.fromEntries(
      register.rows.map((row) => [row.doc.id, row.assessment.verdict]),
    );
    expect(byVerdict).toEqual({
      "SCRIPT-discharge-letters": "run-failed",
      "SCRIPT-lvef-trend": "definition-moved",
      "SCRIPT-admissions-load": "inputs-moved",
      "SCRIPT-cohort-build": "code-moved",
      "SCRIPT-frailty-index": "never-run",
      "SCRIPT-echo-qc": "current",
    });
  });

  it("counts the two findings the board leads with", () => {
    expect(register.summary).toMatchObject({ unhashed: 1, orphanRuns: 1 });
    expect(register.orphanRuns[0]?.id).toBe("RUN-2026-06-03-0001");
  });

  it("flags the input that moved and leaves the one that did not alone", () => {
    const row = register.rows.find((entry) => entry.doc.id === "SCRIPT-admissions-load")!;
    expect(row.assessment.findings).toHaveLength(1);
    expect(row.assessment.findings[0]?.detail).toContain("SCDB-invented-admissions");
    expect(row.assessment.findings[0]?.detail).toContain("2026-07-15");
  });

  it("makes the C2 join fire on a citation that names no version at all", () => {
    // The catalogue board has nothing to call stale here — the ref is
    // unversioned — and yet the figure was drawn under a definition that has
    // since moved. Only a date can answer that, which is why C3 asks it.
    const row = register.rows.find((entry) => entry.doc.id === "SCRIPT-lvef-trend")!;
    expect(row.assessment.consumed[0]).toMatchObject({ citedVersion: null, revisedAfterRun: true });
    expect(row.assessment.findings[0]?.detail).toContain("VAR-EJECTION moved to version 3");
  });

  it("separates the file's hash from the hash that actually ran", () => {
    // The .R file beside the note still matches `file_hash`; the run recorded
    // something else. A hash on the note proves the documentation is current,
    // and only the hash on the run proves what made the numbers.
    const doc = docs.find((entry) => entry.id === "SCRIPT-cohort-build")!;
    const source = onDisk.find((file) => file.rel === "50 Scripts/cohort-build.R")!;
    expect(createHash("sha256").update(source.text, "utf8").digest("hex")).toBe(doc.fileHash);

    const run = runs.find((entry) => entry.id === "RUN-2026-05-12-0001")!;
    expect(run.scriptHash).not.toBe(doc.fileHash);
  });

  it("keeps every fixture parsing clean apart from the staged gaps", () => {
    for (const doc of docs) {
      // SCRIPT-frailty-index deliberately records no hash and no run.
      const staged = doc.id === "SCRIPT-frailty-index";
      expect({ id: doc.id, clean: doc.problems.length === 0 }).toEqual({ id: doc.id, clean: true });
      expect(doc.fileHash === "").toBe(staged);
    }
  });
});

describe("diagram notes (§5.14, §7 D1)", () => {
  const diagrams = typed(DIAGRAM_NOTE_TYPE);

  it("ships at least one, so the editor has a worked example to open", () => {
    expect(diagrams.length).toBeGreaterThan(0);
  });

  it("parses clean — a fixture with a dangling arrow teaches the wrong thing", () => {
    for (const note of diagrams) {
      const { spec, problems } = parseDiagram(note.front);
      expect({ rel: note.rel, problems }).toEqual({ rel: note.rel, problems: [] });
      expect(spec.nodes.length).toBeGreaterThan(0);
      expect(spec.edges.length).toBeGreaterThan(0);
    }
  });

  it("keeps the committed Mermaid block in step with the frontmatter", () => {
    // The block in the body is generated, and a fixture whose picture no longer
    // matches its own data is worse than one with no picture: it is the exact
    // drift the `generated_from` stamp exists to make visible, shipped as an
    // example of how things should look.
    for (const note of diagrams) {
      const file = files.find((entry) => entry.rel === note.rel)!;
      const { spec } = parseDiagram(note.front);
      expect({ rel: note.rel, hasBlock: file.text.includes(toMermaidBlock(spec)) }).toEqual({
        rel: note.rel,
        hasBlock: true,
      });
    }
  });

  it("escapes every label it draws, because a diagram renders vault text", () => {
    for (const note of diagrams) {
      const { spec } = parseDiagram(note.front);
      const source = toMermaid(spec);
      expect(source).not.toMatch(/<[a-zA-Z/]/);
    }
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

describe("events and obligations through the recurrence engine (§5.7)", () => {
  const notes = [...typed("obligation"), ...typed("event")].map((note) =>
    parseEventNote(note.rel, note.front),
  );

  it.each(notes.map((note) => note.path))("%s reads with no problems", (path) => {
    expect(notes.find((note) => note.path === path)!.problems).toEqual([]);
  });

  it("ships a worked example of every state the board has to paint", () => {
    // The fixtures are documentation as much as fixture (§5): if a state has no
    // example, the first time anyone sees it is in a real vault.
    const schedule = buildSchedule(notes, {
      today: "2026-08-23",
      horizonDays: 60,
      defaultLeadDays: [30, 7, 1],
    });
    const states = new Set(schedule.map((entry) => entry.state));
    expect(states.has("lapsed")).toBe(true);
    expect(schedule.some((entry) => entry.source === "computed")).toBe(true);
    expect(schedule.some((entry) => entry.source === "due")).toBe(true);
  });

  it("gives every recurring obligation a date the engine can work out", () => {
    // A rule with no anchor and no due is watched by nothing, which is the one
    // failure §5.7 is written against. No shipped fixture may demonstrate it
    // by accident.
    const blind = notes.filter(
      (note) => note.recurrence !== null && occurrenceDate(note).date === "",
    );
    expect(blind.map((note) => note.path)).toEqual([]);
  });

  it("survives a round trip through the calendar file", () => {
    const schedule = buildSchedule(notes, {
      today: "2026-08-23",
      horizonDays: 60,
      defaultLeadDays: [30, 7, 1],
    });
    const events = calendarEvents(schedule);
    const parsed = parseCalendar(buildCalendar(events, { now: Date.parse("2026-08-23T00:00:00Z") }));
    expect(parsed.problems).toEqual([]);
    expect(parsed.events.map((entry) => entry.date).sort()).toEqual(
      events.map((entry) => entry.date).sort(),
    );
  });

  it("puts nothing in the calendar that the note did not already say", () => {
    // §7 B3's governance line: refs, dates, titles and the consequence. The
    // body of a note never reaches a file that travels.
    const schedule = buildSchedule(notes, {
      today: "2026-08-23",
      horizonDays: 60,
      defaultLeadDays: [30, 7, 1],
    });
    for (const entry of calendarEvents(schedule)) {
      const note = notes.find((candidate) => entry.summary.startsWith(`${candidate.id} `))!;
      expect(entry.summary).toBe(`${note.id} — ${note.title || note.id}`);
      if (note.consequence !== "") expect(entry.description).toContain(note.consequence);
      expect(entry.description).not.toContain("Fixture note");
    }
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

describe("no real address anywhere in the test vault", () => {
  it("scans every file on disk, tracked or not", () => {
    // This one reads `onDisk` rather than the tracked fixture set, and that is
    // the point: a real address typed into a note git happens to be ignoring
    // is exactly the one nobody would notice. It is not a repo risk — an
    // ignored file cannot be committed — but rule 1 is about what enters the
    // vault at all, and the generated notes are written from fixture data, so
    // a real address appearing in one means it came from a fixture.
    const offenders: string[] = [];
    for (const file of onDisk) {
      for (const match of file.text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
        if (/@(example\.(com|org|net)|.*\.example)$/.test(match[0])) continue;
        // A frozen policy revision is filed as `POL-DATA-REL-02@3.md` (§7 C1),
        // which this pattern reads as an address at the domain "3.md". A
        // filename is not a disclosure, and a scanner that cries wolf is one
        // that gets muted. Only the extension is excused — anything at a real
        // TLD still fails, including `@3.com`.
        if (/@[\w-]+\.(md|ya?ml|csv|html?|json|png|pdf|base|ics|eml|msg)$/i.test(match[0])) continue;
        offenders.push(`${file.rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
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

describe("the ban on committing correspondence has no exception", () => {
  // §5.10 permits full message bodies and attachments in `75 Correspondence/`,
  // which makes it the folder most able to carry something real into a public
  // repo. The protection is an unconditional gitignore rule, so these fixtures
  // live in `75 Correspondence-fixtures/` — a name that rule never covered —
  // rather than behind a `!` exception. An exception is a rule you have to
  // remember; a rename is one you cannot forget.
  const gitignore = readFileSync(join(__dirname, "..", ".gitignore"), "utf8");

  it("still bans the real folder name outright", () => {
    expect(gitignore).toContain("**/75 Correspondence/");
  });

  it("un-ignores nothing", () => {
    const exceptions = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!"));
    expect(exceptions).toEqual([]);
  });

  it("keeps every committed fixture out of a folder that would be ignored", () => {
    // `files` is the tracked set on purpose. The plugin's *own* output belongs
    // in `75 Correspondence/` — that is the shipped default write folder and
    // the whole reason the rename is safe — so an ignored thread sitting there
    // is the design working, not a breach. What must never happen is a fixture
    // we meant to commit landing there, where the ban would hide it and a
    // fresh clone would silently come up short.
    const inside = files.filter((file) => file.rel.split("/").includes("75 Correspondence"));
    expect(inside.map((file) => file.rel)).toEqual([]);
  });
});

describe("the shipped .eml fixtures, through the real parser (§5.10)", () => {
  // Read as bytes, because that is how the plugin reads them: the reply is
  // declared iso-8859-1 and carries windows-1252 punctuation, which is exactly
  // what decoding the file as UTF-8 first would destroy.
  const emls = files
    .filter((file) => file.rel.endsWith(".eml"))
    .map((file) => ({
      rel: file.rel,
      bytes: readFileSync(join(VAULT, file.rel)),
    }));

  const MINE = new Set(["yh@example.org"]);
  const options: PlanOptions = {
    ownAddresses: MINE,
    knownRequestIds: ["REQ-2026-004"],
    knownPeople: ["Dr A Tan"],
    attachments: "attachments",
    maxAttachmentKb: 10240,
    fallbackAt: Date.parse("2026-08-20T00:00:00Z"),
  };

  const parsed = emls.map((file) => ({
    rel: file.rel,
    message: parseEml(new Uint8Array(file.bytes)),
  }));

  it("ships a worked example of both directions", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    const directions = parsed.map(
      (entry) => planMessage(entry.message, entry.rel, options).direction,
    );
    expect(new Set(directions)).toEqual(new Set(["inbound", "outbound"]));
  });

  it.each(parsed.map((entry) => entry.rel))("%s parses with nothing unreadable", (rel) => {
    const entry = parsed.find((candidate) => candidate.rel === rel)!;
    expect(entry.message.problems).toEqual([]);
    expect(entry.message.from.length).toBeGreaterThan(0);
    expect(entry.message.date).not.toBeNull();
  });

  it("decodes the windows-1252 punctuation an iso-8859-1 header really means", () => {
    // Pinned here as well as in the unit tests because Node and Chromium
    // disagree about these bytes, and a vault is a record: the same file must
    // import to the same text on the dev machine and on the work laptop.
    const reply = parsed.find((entry) => entry.rel.endsWith("sample-reply.eml"))!;
    expect(reply.message.body).toContain("right — please proceed");
    expect(reply.message.body).toContain("£200");
    expect(reply.message.body).toContain("don’t");
  });

  it("keeps the attachment as bytes and names it", () => {
    const outbound = parsed.find((entry) => entry.rel.endsWith("sample-outbound.eml"))!;
    expect(outbound.message.attachments).toHaveLength(1);
    expect(outbound.message.attachments[0]!.filename).toBe("qc-outcomes.csv");
    expect(new TextDecoder().decode(outbound.message.attachments[0]!.bytes)).toContain(
      "case_id,outcome",
    );
  });

  it("puts the reply on the same thread as the message it answers", () => {
    // The reason a fortnight of back-and-forth is one note and not nine.
    const keys = parsed.map((entry) => planMessage(entry.message, entry.rel, options).threadKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("links only the request the vault actually has", () => {
    const outbound = parsed.find((entry) => entry.rel.endsWith("sample-outbound.eml"))!;
    expect(planMessage(outbound.message, outbound.rel, options).requests).toEqual([
      "REQ-2026-004",
    ]);
    // A request nobody has created is mentioned in the text and linked to
    // nothing (§2 rule 5: an email never causes anything to exist).
    expect(
      planMessage(outbound.message, outbound.rel, { ...options, knownRequestIds: [] }).requests,
    ).toEqual([]);
  });

  it("writes a thread the correspondence reader accepts without complaint", () => {
    const outbound = parsed.find((entry) => entry.rel.endsWith("sample-outbound.eml"))!;
    const plan = planMessage(outbound.message, outbound.rel, options);
    const note = newThreadFromEml(plan, "THR-2026-0099", "01FIXTUREULID");
    const read = parseThread(note.frontmatter, "THR-2026-0099");

    expect(read.problems).toEqual([]);
    expect(read.thread.awaiting).toBe("them");
    expect(read.thread.threadKey).toBe("scdb-sample-root@example.org");
  });

  it("recognises the reply as already imported the second time round", () => {
    const outbound = parsed.find((entry) => entry.rel.endsWith("sample-outbound.eml"))!;
    const reply = parsed.find((entry) => entry.rel.endsWith("sample-reply.eml"))!;

    const first = planMessage(outbound.message, outbound.rel, options);
    const note = newThreadFromEml(first, "THR-2026-0099", "01FIXTUREULID");
    const thread = parseThread(note.frontmatter, "THR-2026-0099").thread;

    const second = planMessage(reply.message, reply.rel, options);
    expect(threadForMessage([thread], second)?.id).toBe("THR-2026-0099");
    expect(alreadyRecorded(thread, second)).toBe(false);
    expect(alreadyRecorded(thread, first)).toBe(true);
  });

  it("keeps the message text out of the frontmatter", () => {
    // A `messages:` list is read back into briefings and exports. Rule 7 keeps
    // content out of anything derived; only the subject goes in.
    const reply = parsed.find((entry) => entry.rel.endsWith("sample-reply.eml"))!;
    const plan = planMessage(reply.message, reply.rel, options);
    const note = newThreadFromEml(plan, "THR-2026-0099", "01FIXTUREULID");
    expect(JSON.stringify(note.frontmatter)).not.toContain("recharge");
  });
});

describe("the profile fixtures (§5.9, §7 B7)", () => {
  const notes = files
    .filter((file) => file.rel.startsWith("84 Profile/"))
    .map((file) => {
      const yaml = frontmatterOf(file.text);
      if (yaml === null) throw new Error(`${file.rel}: no frontmatter.`);
      const note = parseProfileNote(file.rel, loadRecord(yaml, file.rel));
      if (note === null) throw new Error(`${file.rel}: not a profile note type.`);
      return note;
    });

  it("cover all six types §5.9 names", () => {
    expect([...new Set(notes.map((note) => note.type))].sort()).toEqual([...PROFILE_TYPES].sort());
  });

  it("parse without a single complaint", () => {
    // A profile note is ten seconds of typing. If the shipped examples cannot
    // be read cleanly, the contract they document is the wrong one.
    expect(notes.flatMap((note) => note.problems)).toEqual([]);
  });

  it("resolve a period from whichever key the type uses", () => {
    for (const note of notes) {
      expect(note.year, note.path).not.toBeNull();
    }
  });

  it("only claim 'present' where the note says so", () => {
    const ongoing = notes.filter((note) => note.period.ongoing).map((note) => note.type);
    expect(ongoing).toEqual(["service"]);
  });

  it("build a CV with every section filled", () => {
    const publications = files
      .filter((file) => file.rel.startsWith("85 Publications/"))
      .map((file) => {
        const yaml = frontmatterOf(file.text);
        return parsePublication(file.rel, loadRecord(yaml ?? "", file.rel));
      });

    const cv = composeCv({ profile: notes, publications, format: "vancouver" });
    expect(cv.sections.map((section) => section.heading)).toEqual([
      "Publications",
      "Grants and funding",
      "Supervision",
      "Teaching",
      "Presentations",
      "Awards",
      "Service",
    ]);
    expect(cv.total).toBeGreaterThan(notes.length);
  });

  it("show a status on the grant that is not awarded, and none on the one that is", () => {
    const grants = notes.filter((note) => note.type === "grant").map(cvLine);
    expect(grants.filter((line) => /submitted/i.test(line))).toHaveLength(1);
    expect(grants.filter((line) => /awarded/i.test(line))).toHaveLength(0);
  });
});

describe("REDCap forms and the governance hook (§5.14, §7 D2)", () => {
  const studies = typed(STUDY_TYPE).map((note) =>
    parseStudy({ path: note.rel, frontmatter: note.front }),
  );
  const variables = typed(VARIABLE_TYPE).map((note) => parseVariable(note.rel, note.front));

  // Fields live in a fenced block in the body, not in frontmatter (§7 D2), so
  // the fixture set is read from the file text rather than from `notes`.
  const specs = typed(REDCAP_FORM_TYPE).map((note) => {
    const file = files.find((entry) => entry.rel === note.rel)!;
    const block = findBlock(file.text);
    return parseFormSpec({
      path: note.rel,
      frontmatter: note.front,
      block: block === null ? null : load(block.body),
      blockProblems: block === null ? ["no block"] : [],
    });
  });

  const register = buildFormsRegister({ specs, studies, variables });

  it("ships studies and forms, so the board has something to open", () => {
    expect(studies.length).toBeGreaterThan(0);
    expect(specs.length).toBeGreaterThan(0);
  });

  it("reads every form's block without a parse problem of its own", () => {
    for (const spec of specs) {
      const unreadable = spec.problems.filter((problem) => /not readable as YAML|no `redcap` block/.test(problem));
      expect({ id: spec.id, unreadable }).toEqual({ id: spec.id, unreadable: [] });
    }
  });

  it("demonstrates every verdict the register can reach", () => {
    // Pinned deliberately, as C2 and C3 are: each fixture exists to make one
    // group render against a real note. A board that only ever shows problems
    // teaches you to ignore it, so `ready` has a fixture too.
    const byVerdict = Object.fromEntries(register.forms.map((form) => [form.spec.id, form.verdict]));
    expect(byVerdict).toEqual({
      "FORM-invented-screening": "blocked",
      "FORM-invented-legacy": "invalid",
      "FORM-invented-baseline": "questions",
      "FORM-invented-followup": "ready",
    });
  });

  it("blocks only the identifier outside an approved scope", () => {
    const blocked = register.forms.find((form) => form.spec.id === "FORM-invented-screening")!;
    const blocking = blocked.governance.findings.filter((finding) => finding.blocking);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.field).toBe("screen_mrn");
    expect(blocked.exportable).toBe(false);
    // Justified on the field, and still blocked: why the facility wants it and
    // whether anyone approved it are different questions.
    expect(blocked.governance.findings.map((finding) => finding.kind)).toEqual(["unapproved"]);
  });

  it("reports an unrecorded scope as uncheckable rather than as a pass", () => {
    expect(register.summary.uncheckable).toBe(1);
    const legacy = register.forms.find((form) => form.spec.id === "FORM-invented-legacy")!;
    expect(legacy.governance.findings.some((finding) => finding.kind === "unknown-scope")).toBe(true);
  });

  it("makes the C2 join fire: an identifier the catalogue cannot justify either", () => {
    const baseline = register.forms.find((form) => form.spec.id === "FORM-invented-baseline")!;
    const kinds = baseline.governance.findings.map((finding) => finding.kind);
    expect(kinds).toContain("unjustified");
    expect(kinds).toContain("unflagged");
    expect(baseline.errors).toEqual([]);
  });

  it("fires one instance of each validation rule the broken fixture exists for", () => {
    const legacy = register.forms.find((form) => form.spec.id === "FORM-invented-legacy")!;
    const codes = new Set(legacy.errors.map((finding) => finding.code));
    for (const code of [
      "name-shape",
      "name-reserved",
      "choice-duplicate",
      "calc-empty",
      "bound-inverted",
      "branching-invalid",
    ]) {
      expect({ code, present: codes.has(code) }).toEqual({ code, present: true });
    }
  });

  it("leaves the clean form with nothing at all to say", () => {
    const clean = register.forms.find((form) => form.spec.id === "FORM-invented-followup")!;
    expect(clean.findings).toEqual([]);
    expect(clean.governance.findings).toEqual([]);
    expect(clean.exportable).toBe(true);
  });

  /** §9: export → import → export produces an identical file, on a real form. */
  it("round-trips a shipped form through the dictionary unchanged", () => {
    const baseline = register.forms.find((form) => form.spec.id === "FORM-invented-baseline")!;
    const first = toDictionaryCsv(baseline.spec);
    const back = fromDictionaryCsv(first);
    // Through `instrumentsToBlock`, because that is the path the writer takes:
    // a parsed field is not itself valid block input, and `fieldToBlock` is the
    // documented bridge between the two (pinned in dictionary.test.ts).
    const second = toDictionaryCsv(
      parseFormSpec({
        path: baseline.spec.path,
        frontmatter: { id: baseline.spec.id },
        block: instrumentsToBlock(back.instruments),
      }),
    );
    expect(second).toBe(first);
  });
});

describe("vault apps (§5.13, §7 F3)", () => {
  // An app's code lives in a fenced block in the body, so the fixture set is
  // read from the file text rather than from `notes` — same as the forms.
  const manifests = typed(VAULT_APP_TYPE).map((note) => {
    const file = files.find((entry) => entry.rel === note.rel)!;
    return parseManifest({ path: note.rel, frontmatter: note.front, body: file.text });
  });

  it("ships apps, so the board has something to open", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  /**
   * Pinned by id. These four are the four states the board groups by, and a
   * fixture that quietly stops demonstrating its state teaches the wrong thing.
   */
  it("covers every state the board can show", () => {
    const register = buildAppsRegister(manifests, {});
    const byState = Object.fromEntries(
      register.map((entry) => [entry.manifest.id, entry.state]),
    );
    expect(byState).toEqual({
      "APP-invented-empty": "broken",
      "APP-invented-queue": "consent",
      "APP-invented-triage": "consent",
      "APP-invented-overreach": "consent",
    });
    expect(summariseApps(register).broken).toBe(1);
  });

  it("moves an app to ready once it has been granted, and only that app", () => {
    const queue = manifests.find((entry) => entry.id === "APP-invented-queue")!;
    const grants = { "APP-invented-queue": newGrant(queue.capabilities, "2026-08-29") };
    const register = buildAppsRegister(manifests, grants);
    const ready = register.filter((entry) => entry.state === "ready");
    expect(ready.map((entry) => entry.manifest.id)).toEqual(["APP-invented-queue"]);
  });

  /** §5.13: an app trusted at one scope, edited to ask for more, must re-ask. */
  it("catches the shipped app being widened after it was granted", () => {
    const queue = manifests.find((entry) => entry.id === "APP-invented-queue")!;
    const grants = { "APP-invented-queue": newGrant(queue.capabilities, "2026-08-29") };
    const widened = {
      ...queue,
      capabilities: { ...queue.capabilities, query: [...queue.capabilities.query, CORRESPONDENCE_TYPE] },
    };
    const [entry] = buildAppsRegister([widened], grants);
    expect(entry?.state).toBe("changed");
    expect(entry?.check.changes.join(" ")).toContain(CORRESPONDENCE_TYPE);
  });

  /** Rule 3: no app is the gateway, whatever its manifest says. */
  it("refuses the greedy fixture's request for the network, and says so", () => {
    const greedy = manifests.find((entry) => entry.id === "APP-invented-overreach")!;
    expect(greedy.capabilities.network).toBe(false);
    expect(greedy.problems.join(" ")).toContain("Vault apps never get it");
  });

  it("says the unfinished fixture has nothing to run rather than offering to run it", () => {
    const empty = manifests.find((entry) => entry.id === "APP-invented-empty")!;
    expect(empty.source).toBe("");
    expect(empty.problems.join(" ")).toContain("nothing to run");
  });

  /**
   * Every shipped app is put through the real page builder. The frame is where
   * rules 3 and 4 are actually enforced, and a fixture whose source broke the
   * page open would be a fixture that silently stopped testing them.
   */
  it("builds a page for every shipped app with its guards intact", () => {
    for (const manifest of manifests) {
      if (manifest.source === "") continue;
      const page = buildFrame({
        runtime: "globalThis.__scdbRuntime = {};",
        source: manifest.source,
        title: manifest.title,
        theme: {},
      });
      expect(page, manifest.id).toContain("connect-src 'none'");
      // One script element, opened once and closed once: app source that
      // escaped it would spill the rest of the file into the page as markup.
      expect(page.match(/<script/g)?.length, manifest.id).toBe(1);
      expect(page.match(/<\/script>/g)?.length, manifest.id).toBe(1);
    }
  });
});

describe("runnable blocks (§5.12, §7 F1)", () => {
  const workbench = files.find((file) => file.rel.endsWith("Invented block workbench.md"));

  it("ships a note with blocks to run", () => {
    expect(workbench).toBeDefined();
  });

  /**
   * Pinned deliberately. The workbench is where F1 is exercised by hand, and
   * a fixture that quietly lost its R block, or gained a runnable copy of the
   * destructive one, would still look fine on screen.
   */
  it("offers exactly the blocks the note says it offers", () => {
    const blocks = findRunnableBlocks(workbench?.text ?? "");
    expect(blocks.map((block) => `${block.language} #${block.ordinal}`)).toEqual([
      "python #1",
      "python #2",
      "r #1",
      "r #2",
    ]);
  });

  // The one block that must never be offered. It calls shutil.rmtree.
  it("keeps the no-run block off the list", () => {
    expect(workbench?.text).toContain("```python no-run");
    const blocks = findRunnableBlocks(workbench?.text ?? "");
    expect(blocks.some((block) => block.source.includes("rmtree"))).toBe(false);
  });

  /**
   * A committed fixture must carry no output.
   *
   * Running one writes an output block and a figure into the note, and a
   * committed copy of that would put a generated PNG and a machine-written
   * transcript into a public repo — and would make the next run look like it
   * had already happened.
   */
  it("carries no output from a previous run", () => {
    expect(workbench?.text).not.toContain("scdb-run");
    expect(workbench?.text).not.toContain("![[94 Runs/");
  });

  it("commits no run records or figures", () => {
    const runs = files.filter((file) => file.rel.startsWith("94 Runs/"));
    expect(runs.map((file) => file.rel)).toEqual([]);
  });
});
