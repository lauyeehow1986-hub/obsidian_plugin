/**
 * Index and query benchmark — the A2 acceptance criterion.
 *
 * CLAUDE.md §7 A2: "re-indexing a 5,000-note vault stays under a second". This
 * measures exactly that, plus the two things that happen every time a board
 * repaints: building rows (which recomputes every dwell time from `history`,
 * because §5.1 forbids caching them) and running a query over the result.
 *
 * It bundles the data layer against a stub `obsidian`, so it measures our code
 * rather than Obsidian's metadata cache. That is the honest scope: the cache is
 * Obsidian's problem and is already warm by the time we read it.
 *
 * Run: `npm run bench` (optionally `npm run bench -- 20000`).
 */
import esbuild from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NOTES = Number(process.argv[2] ?? 5000);
const REQUEST_SHARE = 0.6;

const OBSIDIAN_STUB = `
export class TFile { constructor() { this.path = ""; this.basename = ""; this.extension = "md"; } }
export class TFolder {}
export class TAbstractFile {}
export class Notice {}
export function normalizePath(p) { return String(p).replace(/\\\\/g, "/"); }
export function parseYaml() { return {}; }
export function debounce(fn) { return fn; }
`;

const ENTRY = `
export { NoteIndex } from "./src/data/noteIndex.ts";
export { RequestIndex } from "./src/data/requestIndex.ts";
export { buildRows, catalogueFor } from "./src/data/rows.ts";
export { runQuery } from "./src/domain/query/evaluate.ts";
export { REQUEST_FIELDS } from "./src/domain/request/queryFields.ts";
export { andGroup, condition, emptyQuery } from "./src/domain/query/model.ts";
export { buildVocabulary } from "./src/data/vocabulary.ts";
export { chipsToQuery, parseQueryText } from "./src/domain/query/language.ts";
`;

const stubPlugin = {
  name: "obsidian-stub",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: OBSIDIAN_STUB,
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "scdb-bench-"));
const outfile = join(dir, "bundle.mjs");

await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile,
  plugins: [stubPlugin],
  logLevel: "warning",
});

const mod = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------- a synthetic vault -- */

const STAGES = ["intake", "triage", "awaiting-approval", "approved", "extraction", "qc", "delivered"];
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 22);

/**
 * People, named the way a clinical vault names them.
 *
 * The honorific matters to the measurement, not just to the flavour. Every
 * name here starts with "Dr", so every one of them lands in the same bucket of
 * the search box's phrase index — which is exactly the shape that turned the
 * index build quadratic. A pool of `Person 0..39` never showed it.
 *
 * The pool is larger than `VALUE_CAP` (500) on purpose, so the search bench
 * measures the ceiling rather than a comfortable case.
 */
const SURNAMES = ["Tan", "Lim", "Chan", "Ng", "Wong", "Koh", "Teo", "Goh", "Sim", "Yeo"];
const PEOPLE = 600;

function person(index) {
  const at = index % PEOPLE;
  return `Dr ${String.fromCharCode(65 + (at % 26))}${at} ${SURNAMES[at % SURNAMES.length]}`;
}

function requestFrontmatter(index) {
  const start = NOW - (30 + (index % 400)) * DAY;
  const steps = 2 + (index % 6);
  const history = [];
  for (let step = 0; step < steps; step++) {
    history.push({
      at: new Date(start + step * 4 * DAY).toISOString().slice(0, 10),
      to: STAGES[step % STAGES.length],
      by: "bench",
    });
  }
  return {
    type: "scdb-request",
    uid: `01BENCH${String(index).padStart(18, "0")}`,
    id: `REQ-2026-${String(index).padStart(5, "0")}`,
    title: `Synthetic benchmark request ${index}`,
    workflow: "edata-request",
    workflow_version: 2,
    stage: history[history.length - 1].to,
    blocked_on: index % 3 === 0 ? `[[${person(index)}]]` : null,
    blocked_since: new Date(start).toISOString().slice(0, 10),
    requester: `[[${person(index + 7)}]]`,
    study: `[[Study ${index % 12}]]`,
    hat: "hod",
    received: new Date(start).toISOString().slice(0, 10),
    due: new Date(start + 21 * DAY).toISOString().slice(0, 10),
    sla_days: 21,
    priority: index % 7 === 0 ? "high" : "normal",
    governance: { identifiers: index % 5 === 0 ? "indirect" : "none", irb_ref: `DSRB-${index}` },
    evidence: [],
    outputs: [],
    history,
  };
}

function otherFrontmatter(index) {
  return {
    type: "publication",
    id: `PUB-${index}`,
    title: `Synthetic benchmark publication ${index}`,
    stage: index % 2 === 0 ? "under-review" : "published",
    journal: `Journal ${index % 20}`,
    authors: [`[[${person(index)}]]`],
    submitted: new Date(NOW - (index % 300) * DAY).toISOString().slice(0, 10),
    scdb_supported: index % 3 === 0,
  };
}

const files = [];
const cache = new Map();
for (let index = 0; index < NOTES; index++) {
  const isRequest = index < NOTES * REQUEST_SHARE;
  const path = isRequest ? `10 Requests/REQ-${index}.md` : `85 Publications/PUB-${index}.md`;
  const file = { path, basename: path.split("/").pop().replace(/\.md$/, ""), extension: "md" };
  files.push(file);
  cache.set(path, {
    frontmatter: isRequest ? requestFrontmatter(index) : otherFrontmatter(index),
  });
}

const app = {
  vault: { getMarkdownFiles: () => files },
  metadataCache: { getFileCache: (file) => cache.get(file.path) ?? null },
};

const SPEC = {
  id: "edata-request",
  version: 2,
  label: "eData request",
  stages: STAGES.map((id, position) => ({
    id,
    label: id,
    owner: "scdb",
    slaDays: [2, 3, 14, 1, 10, 3, null][position],
    terminal: id === "delivered",
  })),
  transitions: [],
  gates: [],
  retired: {},
};

const workflows = {
  forRequest: () => SPEC,
  // The search box takes its stage words from here (§7 B4).
  usable: () => [SPEC],
};

/* ------------------------------------------------------------------- run -- */

function time(label, fn) {
  const started = performance.now();
  const value = fn();
  const ms = performance.now() - started;
  console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms`);
  return { value, ms };
}

const notes = new mod.NoteIndex(app);
const requests = new mod.RequestIndex(app, notes, workflows);

console.log(`\n${NOTES} notes (${Math.round(NOTES * REQUEST_SHARE)} requests)\n`);

const noteBuild = time("NoteIndex.rebuild", () => notes.rebuild());
const requestBuild = time("RequestIndex.rebuild", () => requests.rebuild());

const deps = { notes, requests, workflows };
const catalogue = mod.catalogueFor(deps, []);
const rows = time("buildRows (all types)", () => mod.buildRows(deps, [], NOW)).value;

const query = {
  ...mod.emptyQuery(["scdb-request"]),
  where: mod.andGroup([
    mod.condition("blocked_on", "not-empty"),
    {
      kind: "group",
      combine: "or",
      negate: false,
      clauses: [
        mod.condition("sla_state", "is", "breached"),
        mod.condition("dwell", "gt", "2w"),
      ],
    },
  ]),
  sort: [{ field: "dwell", direction: "desc" }],
  group: { field: "blocked_on", direction: "asc" },
  aggregates: [{ fn: "count" }, { fn: "median", field: "dwell" }],
  columns: ["id", "title", "stage_label", "dwell", "age", "bounces"],
};

const result = time("runQuery (filter+group+aggs)", () =>
  mod.runQuery(rows, query, catalogue, { now: NOW }),
).value;

/* --------------------------------------------- the English box, per keystroke -- */

// B4 re-parses on every keystroke, and `searchInEnglish` does it twice when
// the sentence changes which note types are in play. So the number that
// matters is not one parse — it is what a held-down key costs.
const vocab = time("buildVocabulary", () => mod.buildVocabulary(deps, ["scdb-request"]));

// Take the name out of the vocabulary rather than writing one here, so the
// bench cannot quietly start measuring a sentence that no longer matches
// anything — a parse that understands nothing is fast and worthless.
const who = vocab.value.values.blocked_on?.[0] ?? "nobody";
const SENTENCE = `requests stuck in awaiting-approval more than 2 weeks waiting on ${who}`;

const parse = time("parseQueryText", () => mod.parseQueryText(SENTENCE, vocab.value));
const keystroke = 2 * (vocab.ms + parse.ms);
const names = Object.values(vocab.value.values).reduce((total, list) => total + list.length, 0);

const reindex = noteBuild.ms + requestBuild.ms;
console.log(
  `\nrows: ${rows.length} · fields: ${catalogue.length} · matched: ${result.matched} · groups: ${result.groups.length}`,
);
console.log(
  `names indexed: ${names} · chips: ${parse.value.chips.length} · ignored: ${parse.value.ignored.length}`,
);
console.log(`\nre-index total ${reindex.toFixed(0)} ms — budget 1000 ms`);
console.log(`worst-case keystroke ${keystroke.toFixed(0)} ms — budget 50 ms\n`);

writeFileSync(
  join(dir, "result.json"),
  JSON.stringify({ notes: NOTES, reindex, keystroke }, null, 2),
);

if (reindex > 1000) {
  console.error("Re-index is over the A2 budget.");
  process.exit(1);
}

// A search box that stutters is a search box nobody uses. This caught a
// quadratic phrase-index build that only showed up once the vault held
// several hundred people whose names all begin "Dr".
if (keystroke > 50) {
  console.error("The English search box is too slow per keystroke.");
  process.exit(1);
}

if (parse.value.chips.length !== 4 || parse.value.ignored.length !== 0) {
  console.error(`The bench sentence no longer parses: ${SENTENCE}`);
  process.exit(1);
}
