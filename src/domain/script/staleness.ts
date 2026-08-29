/**
 * Has this script's output been overtaken? (§7 C3)
 *
 * C3's deliverable in one sentence: *"Flags scripts not re-run since their
 * input dataset changed, and links consumed variables to C2."* Both are the
 * same comparison — something the script depends on moved after the last time
 * it ran — so both live here, along with the two others that follow from
 * §5.12's run record.
 *
 * **Silence is not freshness.** A script with no recorded run, or with runs
 * that carry no date, is not "current"; it is unanswerable, and it gets a
 * finding of its own saying so. This is the same rule the catalogue applies
 * when resolving a past definition: the honest answer to a question the vault
 * cannot answer is "not recorded", never the reassuring default.
 *
 * **The version-mismatch case stays on the catalogue board.** A script citing
 * `VAR-LVEF@2` while the catalogue is at 3 is C2's `stale` finding and is
 * already reported there. What C3 adds is the *time* question — the definition
 * moved after this script last ran — which is a different fact: a script that
 * cites no version at all still consumed whatever the definition said that
 * day, and only a date can tell you whether that is still what it says.
 *
 * Pure module: no Obsidian, no Node.
 */

import { refMatchesVariable, refTarget, refVersion, type VariableNote } from "../catalogue/variable";
import { toVaultDate } from "../time/dates";
import { runsForScript, type RunRecord } from "./runRecord";
import { shortHash, type ScriptDoc } from "./scriptDoc";

/**
 * What can be wrong, worst first.
 *
 * The order is the severity order, and the board sorts by it. `run-failed`
 * leads because it is the only one where the outputs may not exist at all;
 * `definition-moved` outranks `inputs-moved` because a changed definition
 * means the numbers mean something different, not merely that they are old.
 */
export const FINDING_KINDS = [
  "run-failed",
  "definition-moved",
  "inputs-moved",
  "code-moved",
  "never-run",
  "undated",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type Verdict = FindingKind | "current";

export const VERDICT_LABELS: Record<Verdict, string> = {
  "run-failed": "Last run failed",
  "definition-moved": "A definition moved",
  "inputs-moved": "Input data moved",
  "code-moved": "Code moved",
  "never-run": "Never run",
  undated: "No date to judge by",
  current: "Current",
};

export interface ScriptFinding {
  kind: FindingKind;
  /** Short enough for a chip. */
  label: string;
  /** One plain-English line naming what moved and when. */
  detail: string;
  /** The date that made it true, for sorting and display. */
  at: number | null;
}

/** One catalogue variable the script declares it consumes. */
export interface ConsumedVariable {
  /** The ref exactly as the script doc wrote it. */
  ref: string;
  /** The catalogue entry, or null when the catalogue does not hold it. */
  variable: VariableNote | null;
  /** The version the ref named, or null when it named none. */
  citedVersion: number | null;
  /** The current definition came into force after this script last ran. */
  revisedAfterRun: boolean;
}

export interface ScriptAssessment {
  doc: ScriptDoc;
  /** Every run record pointing at this script, newest first. */
  runs: RunRecord[];
  consumed: ConsumedVariable[];
  /** The best evidence of when it last ran, or null. */
  lastRunAt: number | null;
  /** Where that date came from — the note's own field, or a run record. */
  lastRunSource: "note" | "run" | "none";
  findings: ScriptFinding[];
  verdict: Verdict;
}

function on(at: number | null): string {
  return at === null ? "an unrecorded date" : toVaultDate(at);
}

/**
 * The last run, from both places it can be recorded.
 *
 * The doc's `last_run` and the run records are both legitimate: a run that
 * happened on a machine with no vault still gets typed onto the note, and a
 * run record written by F1 will not always have updated the note. The later of
 * the two is used, because the question is "when did this last run", and the
 * earlier answer is the one known to be incomplete.
 */
function lastRunOf(doc: ScriptDoc, runs: readonly RunRecord[]): {
  at: number | null;
  source: "note" | "run" | "none";
} {
  const newestRun = runs.find((run) => run.started !== null)?.started ?? null;
  if (doc.lastRun === null && newestRun === null) return { at: null, source: "none" };
  if (newestRun === null) return { at: doc.lastRun, source: "note" };
  if (doc.lastRun === null) return { at: newestRun, source: "run" };
  return newestRun >= doc.lastRun
    ? { at: newestRun, source: "run" }
    : { at: doc.lastRun, source: "note" };
}

/** Resolve each declared variable ref against the catalogue. */
function consumedVariables(
  doc: ScriptDoc,
  variables: readonly VariableNote[],
  lastRunAt: number | null,
): ConsumedVariable[] {
  return doc.variables.map((ref) => {
    const variable = variables.find((entry) => refMatchesVariable(ref, entry)) ?? null;
    const revisedAfterRun =
      variable !== null &&
      variable.changed !== null &&
      lastRunAt !== null &&
      variable.changed > lastRunAt;
    return { ref, variable, citedVersion: refVersion(ref), revisedAfterRun };
  });
}

export function assessScript(input: {
  doc: ScriptDoc;
  /** Every run record in the vault; filtered to this script here. */
  runs: readonly RunRecord[];
  /** The catalogue, for the C2 join. */
  variables: readonly VariableNote[];
}): ScriptAssessment {
  const { doc } = input;
  const runs = runsForScript(doc, input.runs);
  const { at: lastRunAt, source: lastRunSource } = lastRunOf(doc, runs);
  const consumed = consumedVariables(doc, input.variables, lastRunAt);
  const findings: ScriptFinding[] = [];

  if (lastRunSource === "none") {
    findings.push({
      kind: runs.length === 0 ? "never-run" : "undated",
      label: runs.length === 0 ? "Never run" : "No date",
      detail:
        runs.length === 0
          ? "Nothing records this script ever running, so there is no point in time to compare its inputs against."
          : `${runs.length} run record${runs.length === 1 ? "" : "s"} point here, but none carries a readable \`started\`, so nothing can be judged against them.`,
      at: null,
    });
  }

  const newest = runs.find((run) => run.started !== null) ?? runs[0];
  if (newest !== undefined && newest.exit !== "" && newest.exit !== "ok") {
    findings.push({
      kind: "run-failed",
      label: "Last run failed",
      detail: `The most recent run (${newest.id || newest.path}) ended \`${newest.exit}\` on ${on(newest.started)}, so its outputs may be missing or partial.`,
      at: newest.started,
    });
  }

  if (lastRunAt !== null) {
    for (const dataset of doc.inputs) {
      if (dataset.changed === null || dataset.changed <= lastRunAt) continue;
      findings.push({
        kind: "inputs-moved",
        label: "Input moved",
        detail: `${dataset.dataset}${dataset.version === "" ? "" : ` (${dataset.version})`} changed on ${on(dataset.changed)}, after this last ran on ${on(lastRunAt)}.`,
        at: dataset.changed,
      });
    }

    for (const entry of consumed) {
      if (!entry.revisedAfterRun || entry.variable === null) continue;
      const variable = entry.variable;
      findings.push({
        kind: "definition-moved",
        label: "Definition moved",
        detail: `${variable.id || refTarget(entry.ref)} moved to version ${variable.version} on ${on(variable.changed)}, after this last ran on ${on(lastRunAt)} — the outputs were produced under the earlier definition.`,
        at: variable.changed,
      });
    }
  }

  // What ran, versus what the note describes. Both hashes have to be present:
  // a run that recorded none cannot say the code is unchanged, and treating a
  // missing hash as a match is precisely the reassuring default §5.12 exists
  // to prevent. The run's own `problems` already reports the absence.
  const hashed = runs.find((run) => run.scriptHash !== "");
  if (hashed !== undefined && doc.fileHash !== "" && hashed.scriptHash !== doc.fileHash) {
    findings.push({
      kind: "code-moved",
      label: "Code moved",
      detail: `The last run with a recorded hash ran \`${shortHash(hashed.scriptHash)}…\`, but this note documents \`${shortHash(doc.fileHash)}…\` — the code and the documentation are not describing the same file.`,
      at: hashed.started,
    });
  }

  findings.sort((a, b) => FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind));
  const verdict: Verdict = findings[0]?.kind ?? "current";

  return { doc, runs, consumed, lastRunAt, lastRunSource, findings, verdict };
}
