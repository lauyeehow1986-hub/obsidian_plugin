/**
 * Execution provenance records — `94 Runs/` (§5.12, §7 C3).
 *
 * §5.12 defines the note; nothing had read one until now. C3 owns the reader
 * because C3 is what the records are *for*: "when was this last run, against
 * which data version, and was it the code the doc describes". F1 will write
 * them from a real execution; until then they are written by hand or by C3's
 * own "record a run", and the reader does not care which.
 *
 * **`script_hash` is the point of the whole note** (§5.12): notes get edited,
 * and "the code that produced this figure" must mean the code that actually
 * ran. A run that recorded no hash is therefore not silently treated as
 * matching — it is a run that cannot answer the question, and the assessment
 * says so rather than assuming the best.
 *
 * Pure module: no Obsidian, no Node.
 */

import { refTarget } from "../catalogue/variable";
import { parseTimestamp } from "../time/dates";
import { normaliseHash, type ScriptDoc } from "./scriptDoc";

export const RUN_TYPE = "run";

/** §5.12's `exit:` vocabulary. */
export const RUN_EXITS = ["ok", "error", "timeout", "killed"] as const;
export type RunExit = (typeof RUN_EXITS)[number];

export const RUN_EXIT_LABELS: Record<RunExit, string> = {
  ok: "Completed",
  error: "Failed",
  timeout: "Timed out",
  killed: "Killed",
};

export function isRunExit(value: unknown): value is RunExit {
  return typeof value === "string" && (RUN_EXITS as readonly string[]).includes(value);
}

/** One dataset a run consumed, with the row count it saw. */
export interface RunInput {
  dataset: string;
  version: string;
  /** Rows read, or null. A count, never content (rule 7). */
  rows: number | null;
}

export interface RunOutput {
  kind: string;
  path: string;
  hash: string;
}

export interface RunRecord {
  path: string;
  id: string;
  /** The script it ran, as written — a wikilink, an id, or a path. */
  script: string;
  request: string;
  language: string;
  /** The interpreter, verbatim, including its version. §5.12's whole argument. */
  interpreter: string;
  started: number | null;
  durationS: number | null;
  /** "" when the note names no exit state — different from `ok`. */
  exit: RunExit | "";
  /** The digest of what actually ran, normalised. "" when not recorded. */
  scriptHash: string;
  inputs: RunInput[];
  variables: string[];
  outputs: RunOutput[];
  problems: string[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRunRecord(path: string, raw: Record<string, unknown>): RunRecord {
  const problems: string[] = [];

  const script = str(raw["script"]);
  if (script === "") {
    problems.push("No `script`, so this run is not attached to anything it can be evidence for.");
  }

  const startedRaw = raw["started"];
  const started = parseTimestamp(startedRaw);
  if (started === null) {
    problems.push("No readable `started`, so this run cannot be placed in time.");
  }

  const exitRaw = str(raw["exit"]).toLowerCase();
  if (exitRaw !== "" && !isRunExit(exitRaw)) {
    problems.push(`Exit state "${exitRaw}" is not one of ${RUN_EXITS.join(", ")}.`);
  }

  const hashRaw = raw["script_hash"];
  const scriptHash = normaliseHash(hashRaw);
  if (hashRaw !== undefined && scriptHash === "") {
    problems.push("`script_hash` is not a sha256 digest, so it proves nothing about what ran.");
  } else if (hashRaw === undefined) {
    problems.push("No `script_hash`, so this run cannot say which version of the code produced it.");
  }

  const inputs: RunInput[] = [];
  for (const entry of list(raw["inputs"])) {
    if (typeof entry === "string") {
      const dataset = entry.trim();
      if (dataset !== "") inputs.push({ dataset, version: "", rows: null });
      continue;
    }
    if (!isRecord(entry)) continue;
    const dataset = str(entry["dataset"]);
    if (dataset === "") continue;
    inputs.push({ dataset, version: str(entry["version"]), rows: num(entry["rows"]) });
  }

  const outputs: RunOutput[] = [];
  for (const entry of list(raw["outputs"])) {
    if (!isRecord(entry)) continue;
    const outPath = str(entry["path"]);
    if (outPath === "") continue;
    outputs.push({ kind: str(entry["kind"]), path: outPath, hash: normaliseHash(entry["hash"]) });
  }

  return {
    path,
    id: str(raw["id"]),
    script,
    request: str(raw["request"]),
    language: str(raw["language"]),
    interpreter: str(raw["interpreter"]),
    started,
    durationS: num(raw["duration_s"]),
    exit: isRunExit(exitRaw) ? exitRaw : "",
    scriptHash,
    inputs,
    variables: list(raw["variables"]).map(str).filter((entry) => entry !== ""),
    outputs,
    problems,
  };
}

/**
 * Whether a run record points at a given script doc.
 *
 * Matched on the ref's target — brackets, alias and folder stripped — against
 * the doc's id and its filename, because `script: "[[SCRIPT-cohort-build]]"`
 * and `script: SCRIPT-cohort-build` are the same statement and a person
 * writing one should not have their run vanish from the board.
 */
export function runMatchesScript(run: RunRecord, doc: ScriptDoc): boolean {
  const target = refTarget(run.script);
  if (target === "") return false;
  const basename = doc.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return (
    target === doc.id.toLowerCase() ||
    target === basename.toLowerCase() ||
    target === doc.path.replace(/\.md$/i, "").toLowerCase()
  );
}

/**
 * Every run of one script, newest first. Undated runs sort last.
 *
 * Compared through an explicit null branch rather than a sentinel: two undated
 * runs subtracted from each other give NaN, and a comparator returning NaN
 * leaves the order to chance.
 */
export function runsForScript(doc: ScriptDoc, runs: readonly RunRecord[]): RunRecord[] {
  return runs
    .filter((run) => runMatchesScript(run, doc))
    .sort((a, b) => {
      if (a.started === null && b.started === null) return a.path.localeCompare(b.path);
      if (a.started === null) return 1;
      if (b.started === null) return -1;
      return b.started - a.started;
    });
}
