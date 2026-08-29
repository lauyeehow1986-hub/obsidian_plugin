/**
 * The script register's model (§5.14, §7 C3).
 *
 * One row per documentation note, grouped by verdict rather than by folder or
 * language, because the board answers one question — *which of these needs
 * re-running before anyone quotes its output again* — and grouping by anything
 * else buries it.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { VariableNote } from "../catalogue/variable";
import type { RunRecord } from "./runRecord";
import { languageLabel, scriptLabel, type ScriptDoc } from "./scriptDoc";
import {
  assessScript,
  FINDING_KINDS,
  VERDICT_LABELS,
  type ScriptAssessment,
  type Verdict,
} from "./staleness";

export interface ScriptRow {
  assessment: ScriptAssessment;
  doc: ScriptDoc;
  /** The note's own parse problems plus every run record's. */
  problems: string[];
}

export interface ScriptGroup {
  verdict: Verdict;
  label: string;
  rows: ScriptRow[];
}

export interface ScriptSummary {
  total: number;
  /** Anything whose verdict is not `current`. */
  needsAttention: number;
  neverRun: number;
  inputsMoved: number;
  definitionsMoved: number;
  codeMoved: number;
  /** Docs with no `file_hash`, so nothing can ever say what ran. */
  unhashed: number;
  /** Run records in the vault that point at no documented script. */
  orphanRuns: number;
  runs: number;
}

export interface ScriptRegister {
  rows: ScriptRow[];
  groups: ScriptGroup[];
  summary: ScriptSummary;
  /** Runs whose `script:` matches nothing — a typo, or an undocumented script. */
  orphanRuns: RunRecord[];
}

/** Groups are laid out worst-first, with `current` last. */
const GROUP_ORDER: Verdict[] = [...FINDING_KINDS, "current"];

export function buildScriptRegister(input: {
  docs: readonly ScriptDoc[];
  runs: readonly RunRecord[];
  variables: readonly VariableNote[];
}): ScriptRegister {
  const rows: ScriptRow[] = input.docs.map((doc) => {
    const assessment = assessScript({ doc, runs: input.runs, variables: input.variables });
    return {
      assessment,
      doc,
      problems: [
        ...doc.problems,
        // A run record's own problems are shown on the script it belongs to:
        // nothing else lists run records, and a run with no `script_hash` is a
        // gap in this script's provenance, not an abstract one.
        ...assessment.runs.flatMap((run) =>
          run.problems.map((problem) => `${run.id || run.path}: ${problem}`),
        ),
      ],
    };
  });

  rows.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.assessment.verdict) - GROUP_ORDER.indexOf(b.assessment.verdict) ||
      a.doc.id.localeCompare(b.doc.id) ||
      a.doc.path.localeCompare(b.doc.path),
  );

  const groups: ScriptGroup[] = [];
  for (const verdict of GROUP_ORDER) {
    const inVerdict = rows.filter((row) => row.assessment.verdict === verdict);
    if (inVerdict.length > 0) {
      groups.push({ verdict, label: VERDICT_LABELS[verdict], rows: inVerdict });
    }
  }

  const claimed = new Set<string>();
  for (const row of rows) for (const run of row.assessment.runs) claimed.add(run.path);
  const orphanRuns = input.runs.filter((run) => !claimed.has(run.path));

  const withKind = (kind: string): number =>
    rows.filter((row) => row.assessment.findings.some((finding) => finding.kind === kind)).length;

  const summary: ScriptSummary = {
    total: rows.length,
    needsAttention: rows.filter((row) => row.assessment.verdict !== "current").length,
    neverRun: withKind("never-run"),
    inputsMoved: withKind("inputs-moved"),
    definitionsMoved: withKind("definition-moved"),
    codeMoved: withKind("code-moved"),
    unhashed: rows.filter((row) => row.doc.fileHash === "").length,
    orphanRuns: orphanRuns.length,
    runs: input.runs.length,
  };

  return { rows, groups, summary, orphanRuns };
}

/**
 * Free-text search across the register.
 *
 * Matches the things a person half-remembers about a script: its id, title,
 * purpose, language, the datasets it reads, the variables it consumes and the
 * files it writes. Deliberately not the query engine — that is a command away
 * for anything structured.
 */
export function searchScripts(rows: readonly ScriptRow[], query: string): ScriptRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];

  return rows.filter((row) => {
    const doc = row.doc;
    const haystack = [
      doc.id,
      doc.title,
      doc.purpose,
      doc.file,
      doc.study,
      languageLabel(doc.language),
      ...doc.inputs.map((input) => `${input.dataset} ${input.version}`),
      ...doc.outputs.map((output) => `${output.kind} ${output.path}`),
      ...doc.variables,
      ...doc.requests,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** How a row is named in a heading or a notice. */
export function scriptRowLabel(row: ScriptRow): string {
  return scriptLabel(row.doc);
}
