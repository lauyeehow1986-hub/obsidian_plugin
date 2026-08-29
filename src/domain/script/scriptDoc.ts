/**
 * Script documentation notes (§5.14, §7 C3).
 *
 * §5.14 names the type and its fields — "purpose, inputs, outputs, data
 * version, last run, hash of the script file" — and §7 C3 says what they are
 * for: flagging scripts not re-run since their input dataset changed, and
 * linking the variables they consume to the catalogue.
 *
 * **The doc is not the code.** `file:` says where the code lives, and it may
 * point outside the vault entirely — a portable R build's working folder, a
 * network share. So `file_hash` is a *recorded* value, not a computed one: the
 * note carries what was last confirmed, and confirming it again is a
 * deliberate action against a file the plugin can actually read. A hash the
 * plugin quietly recomputed on every load would be a hash of whatever is there
 * now, which is the opposite of what "the code that produced this figure" has
 * to mean.
 *
 * **Inputs carry a `changed` date, not just a version.** A version string
 * ("2026-Q2") is what a human quotes; a date is what a comparison needs. Both
 * are kept — the version is the thing cited in a report, the date is the thing
 * that answers "has this moved since the script last ran".
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp } from "../time/dates";

export const SCRIPT_DOC_TYPE = "script-doc";

/**
 * Languages a script doc may declare.
 *
 * §5.12's run record names `r | python | js`. The three extra here are the
 * ones a biostatistics unit actually has scripts in, and a documentation note
 * that cannot describe a Stata do-file is a documentation note people stop
 * filling in. An unrecognised value is reported as a problem, never coerced.
 */
export const SCRIPT_LANGUAGES = ["r", "python", "sql", "stata", "sas", "js", "other"] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

export const SCRIPT_LANGUAGE_LABELS: Record<ScriptLanguage, string> = {
  r: "R",
  python: "Python",
  sql: "SQL",
  stata: "Stata",
  sas: "SAS",
  js: "JavaScript",
  other: "Other",
};

export function isScriptLanguage(value: unknown): value is ScriptLanguage {
  return typeof value === "string" && (SCRIPT_LANGUAGES as readonly string[]).includes(value);
}

/** One dataset the script reads. */
export interface ScriptInput {
  /** What it is called. The only required part. */
  dataset: string;
  /** The version as a person quotes it: "2026-Q2", "v4", "extract of 3 March". */
  version: string;
  /** When that version came into being. Epoch ms, or null when not recorded. */
  changed: number | null;
  note: string;
}

/** One thing the script produces. Mirrors §5.12's run outputs. */
export interface ScriptOutput {
  /** table | plot | dataset | report — free text, shown rather than validated. */
  kind: string;
  path: string;
  note: string;
}

export interface ScriptDoc {
  path: string;
  id: string;
  title: string;
  /** What it is for, in a sentence. §5.14's first field, and the one that ages worst. */
  purpose: string;
  language: ScriptLanguage | "";
  /** Where the code is, as written. May be outside the vault. */
  file: string;
  /** 64 lowercase hex characters, or "" when none is recorded or it is unreadable. */
  fileHash: string;
  /** When the hash was last confirmed against the file. */
  hashChecked: number | null;
  inputs: ScriptInput[];
  outputs: ScriptOutput[];
  /** Catalogue variables it consumes, as written — a ref may name a version. */
  variables: string[];
  study: string;
  requests: string[];
  /** When it was last run, as the note records it. Epoch ms, or null. */
  lastRun: number | null;
  lastRunBy: string;
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

/**
 * A sha256 digest, however it was written.
 *
 * Accepts the `sha256:` prefix §5.12 shows and a bare digest, and is
 * case-insensitive. Anything that is not 64 hex characters comes back empty
 * and is reported — a half-copied hash compares unequal to everything, which
 * would surface as "the code moved" on a script nobody has touched.
 */
export function normaliseHash(value: unknown): string {
  const text = str(value).toLowerCase().replace(/^sha-?256[:=]/, "").trim();
  return /^[0-9a-f]{64}$/.test(text) ? text : "";
}

/** The first twelve characters, which is all a human compares by eye. */
export function shortHash(hash: string): string {
  return hash === "" ? "" : hash.slice(0, 12);
}

function parseInputs(value: unknown, problems: string[]): ScriptInput[] {
  const inputs: ScriptInput[] = [];
  for (const entry of list(value)) {
    // A bare string is allowed: "SCDB-echo" with no version is a real state,
    // and refusing to read it would mean the dataset is not listed at all.
    if (typeof entry === "string") {
      const dataset = entry.trim();
      if (dataset !== "") inputs.push({ dataset, version: "", changed: null, note: "" });
      continue;
    }
    if (!isRecord(entry)) continue;

    const dataset = str(entry["dataset"]) || str(entry["name"]);
    if (dataset === "") {
      problems.push("An entry under `inputs` names no `dataset`, so nothing can be compared against it.");
      continue;
    }
    const changedRaw = entry["changed"];
    const changed = parseTimestamp(changedRaw);
    if (changedRaw !== undefined && changed === null) {
      problems.push(`\`changed\` on input "${dataset}" is not a date the plugin can read.`);
    }
    inputs.push({ dataset, version: str(entry["version"]), changed, note: str(entry["note"]) });
  }
  return inputs;
}

function parseOutputs(value: unknown): ScriptOutput[] {
  const outputs: ScriptOutput[] = [];
  for (const entry of list(value)) {
    if (typeof entry === "string") {
      const path = entry.trim();
      if (path !== "") outputs.push({ kind: "", path, note: "" });
      continue;
    }
    if (!isRecord(entry)) continue;
    const path = str(entry["path"]);
    const kind = str(entry["kind"]);
    if (path === "" && kind === "") continue;
    outputs.push({ kind, path, note: str(entry["note"]) });
  }
  return outputs;
}

export function parseScriptDoc(path: string, raw: Record<string, unknown>): ScriptDoc {
  const problems: string[] = [];

  const id = str(raw["id"]);
  if (id === "") problems.push("No `id`, so a run record has nothing to point at.");

  const purpose = str(raw["purpose"]);
  if (purpose === "") {
    // The field §5.14 names first, and the one that is missing exactly when it
    // is needed: on a script inherited from someone who has left.
    problems.push("No `purpose`. Nothing on this note says what the script is for.");
  }

  const languageRaw = str(raw["language"]).toLowerCase();
  if (languageRaw !== "" && !isScriptLanguage(languageRaw)) {
    problems.push(`Language "${languageRaw}" is not one of ${SCRIPT_LANGUAGES.join(", ")}.`);
  }
  const language: ScriptLanguage | "" = isScriptLanguage(languageRaw) ? languageRaw : "";

  const file = str(raw["file"]);
  if (file === "") {
    problems.push("No `file`, so nothing says where the code is and its hash can never be checked.");
  }

  const hashRaw = raw["file_hash"];
  const fileHash = normaliseHash(hashRaw);
  if (hashRaw !== undefined && fileHash === "") {
    problems.push("`file_hash` is not a sha256 digest, so it cannot be compared with what a run recorded.");
  }

  const lastRunRaw = raw["last_run"];
  const lastRun = parseTimestamp(lastRunRaw);
  if (lastRunRaw !== undefined && lastRun === null) {
    problems.push("`last_run` is not a date the plugin can read.");
  }

  const hashCheckedRaw = raw["hash_checked"];
  const hashChecked = parseTimestamp(hashCheckedRaw);
  if (hashCheckedRaw !== undefined && hashChecked === null) {
    problems.push("`hash_checked` is not a date the plugin can read.");
  }

  return {
    path,
    id,
    title: str(raw["title"]),
    purpose,
    language,
    file,
    fileHash,
    hashChecked,
    inputs: parseInputs(raw["inputs"], problems),
    outputs: parseOutputs(raw["outputs"]),
    // Read with the same keys the catalogue harvests (§5.8), so one line of
    // frontmatter puts a script on both boards.
    variables: [...list(raw["variables"]), ...list(raw["consumes"])]
      .map(str)
      .filter((entry) => entry !== ""),
    study: str(raw["study"]),
    requests: list(raw["requests"]).map(str).filter((entry) => entry !== ""),
    lastRun,
    lastRunBy: str(raw["last_run_by"]),
    problems,
  };
}

/** How a script is named in a picker, a notice or a heading. */
export function scriptLabel(doc: ScriptDoc): string {
  const fallback = doc.path.replace(/^.*\//, "").replace(/\.md$/i, "");
  if (doc.id !== "" && doc.title !== "") return `${doc.id} — ${doc.title}`;
  return doc.title || doc.id || fallback;
}

export function languageLabel(language: string): string {
  if (isScriptLanguage(language)) return SCRIPT_LANGUAGE_LABELS[language];
  return language === "" ? "No language set" : language;
}
