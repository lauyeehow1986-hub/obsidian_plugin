/**
 * Recording that a script was run (§5.12, §7 C3).
 *
 * F1 will write these from a real execution, with the interpreter and the hash
 * in hand. Until then — and afterwards, for everything run in RStudio, on a
 * server, or on somebody else's machine — a run is recorded by hand. The note
 * that comes out is the same §5.12 record either way, because the whole value
 * of `94 Runs/` is that one shape answers "what produced this number".
 *
 * **What this claims, and what it does not.** The plugin did not run anything;
 * it recorded that a person says they did. That distinction is the same one
 * §5.11 draws between `message-composed` and `message-sent`, and it is why the
 * ledger action is `run-recorded` rather than `code-run`. An audit trail that
 * quietly upgrades hearsay to observation is worse than no audit trail.
 *
 * **It refuses only what would make the record meaningless** — a script it
 * cannot point at, and a run it cannot place in time. A missing interpreter or
 * hash weakens the record considerably, and is reported as a problem when the
 * record is read back, but refusing the whole entry over it would mean no
 * record at all. Recording what is true beats recording nothing.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate, toVaultMinute } from "../time/dates";
import { isRunExit, type RunExit } from "./runRecord";
import { normaliseHash, type ScriptDoc } from "./scriptDoc";

export interface RunDraft {
  /** Epoch ms the run started. Required. */
  started: number | null;
  durationS: number | null;
  exit: RunExit;
  /** The interpreter verbatim, version included. §5.12's whole argument. */
  interpreter: string;
  /** Digest of what actually ran. Falls back to the doc's documented hash. */
  scriptHash: string;
  /** Dataset versions this run saw. Seeded from the doc, editable. */
  inputs: { dataset: string; version: string; rows: number | null }[];
  /** One path per line in the dialog. */
  outputs: { kind: string; path: string }[];
  /** The request this run answers, if any. */
  request: string;
}

export interface RunPlan {
  /** `RUN-2026-07-24-0007`. */
  id: string;
  /** The run record's frontmatter, ready for `processFrontMatter`. */
  frontmatter: Record<string, unknown>;
  /** What changes on the script doc itself. */
  patch: Record<string, unknown>;
  refusals: string[];
  /** Things the record cannot answer, said out loud rather than assumed away. */
  weaknesses: string[];
  /** One line for the ledger: ids and counts, no content (rule 7). */
  auditDetail: string;
}

/**
 * The run id for a given day.
 *
 * §5.12's shape, with the sequence supplied by the caller from what is already
 * in the folder. Sequential ids collide when two people allocate at once
 * (§5.2) — here the writer's own filename loop catches it, because a run
 * record is a new file and the vault refuses a duplicate path.
 */
export function runId(at: number, sequence: number): string {
  return `RUN-${toVaultDate(at)}-${String(sequence).padStart(4, "0")}`;
}

export function planRun(input: {
  doc: ScriptDoc;
  draft: RunDraft;
  actor: string;
  /** How many runs already exist for this date. */
  sequence: number;
}): RunPlan {
  const { doc, draft } = input;
  const refusals: string[] = [];
  const weaknesses: string[] = [];

  if (doc.id === "") {
    refusals.push("The script note has no `id`, so a run record has nothing to point at. Give it one first.");
  }
  if (draft.started === null) {
    refusals.push("A run needs a date and time it started, or nothing can be compared against it.");
  }
  if (!isRunExit(draft.exit)) {
    refusals.push(`"${String(draft.exit)}" is not one of ok, error, timeout, killed.`);
  }

  const scriptHash = normaliseHash(draft.scriptHash) || doc.fileHash;
  if (scriptHash === "") {
    weaknesses.push(
      "No script hash, so this record cannot say which version of the code produced its outputs — the one thing §5.12 exists for.",
    );
  }
  if (draft.interpreter.trim() === "") {
    weaknesses.push("No interpreter recorded, so the record cannot say what the code ran under.");
  }
  if (draft.inputs.every((entry) => entry.version.trim() === "")) {
    weaknesses.push("No input data version recorded, so the outputs cannot be tied to an extract.");
  }
  if (draft.outputs.length === 0) {
    weaknesses.push("No outputs listed, so nothing links this run to what it produced.");
  }

  const at = draft.started ?? Date.now();
  const id = runId(at, input.sequence);

  const frontmatter: Record<string, unknown> = {
    type: "run",
    id,
    script: doc.id === "" ? doc.path : `[[${doc.id}]]`,
    // Local time, like every other timestamp the plugin writes. An ISO string
    // in UTC would read as the wrong hour to the person who ran it.
    started: toVaultMinute(at),
    exit: draft.exit,
    // Recorded, not observed — the plugin did not watch this happen. Two keys
    // beyond §5.12's example, on the same argument as `composed_only: true` in
    // §5.10: the honest record of what we actually know.
    recorded_by: input.actor,
    recorded: toVaultDate(Date.now()),
  };
  if (doc.language !== "") frontmatter["language"] = doc.language;
  if (draft.request.trim() !== "") frontmatter["request"] = draft.request.trim();
  if (draft.interpreter.trim() !== "") frontmatter["interpreter"] = draft.interpreter.trim();
  if (draft.durationS !== null) frontmatter["duration_s"] = draft.durationS;
  if (scriptHash !== "") frontmatter["script_hash"] = `sha256:${scriptHash}`;

  const inputs = draft.inputs
    .filter((entry) => entry.dataset.trim() !== "")
    .map((entry) => {
      const record: Record<string, unknown> = { dataset: entry.dataset.trim() };
      if (entry.version.trim() !== "") record["version"] = entry.version.trim();
      if (entry.rows !== null) record["rows"] = entry.rows;
      return record;
    });
  if (inputs.length > 0) frontmatter["inputs"] = inputs;

  // The variables the doc declares are copied onto the run, so the catalogue's
  // dependency map counts the run itself and not only the script. §5.12 names
  // `variables:` on the run record for exactly this reason.
  if (doc.variables.length > 0) frontmatter["variables"] = [...doc.variables];

  const outputs = draft.outputs
    .filter((entry) => entry.path.trim() !== "")
    .map((entry) => {
      const record: Record<string, unknown> = { path: entry.path.trim() };
      if (entry.kind.trim() !== "") record["kind"] = entry.kind.trim();
      return record;
    });
  if (outputs.length > 0) frontmatter["outputs"] = outputs;

  return {
    id,
    frontmatter,
    // Only the fields a run genuinely establishes. The doc's own `inputs` are
    // left alone: what one run happened to read is not a change to what the
    // script is documented to consume.
    patch: {
      last_run: toVaultDate(at),
      last_run_by: input.actor,
    },
    refusals,
    weaknesses,
    auditDetail: `${id}; exit ${draft.exit}; ${inputs.length} input${inputs.length === 1 ? "" : "s"}, ${outputs.length} output${outputs.length === 1 ? "" : "s"}${scriptHash === "" ? "; no script hash" : ""}`,
  };
}
