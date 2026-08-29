/**
 * The §5.12 run record for a run the plugin actually watched (§7 F1).
 *
 * `domain/script/recordRun` writes the other kind: a run that happened in
 * RStudio, on a server, or on somebody else's machine, written down afterwards
 * by a person. The two records deliberately do not look the same, and the
 * difference is the point —
 *
 *  - a recorded run carries `recorded_by` and logs `run-recorded`;
 *  - an observed run carries `ran_by` and logs `code-run`.
 *
 * An auditor reading `94 Runs/` needs to know which of those they are holding,
 * because one is an observation and the other is hearsay. §5.11's `message-composed`
 * draws the same line for the same reason. A test pins the two shapes together
 * so the fields they share cannot drift apart.
 *
 * Pure module: no Obsidian, no Node.
 */

import { renderFence } from "../markdown/fence";
import { runId } from "../script/recordRun";
import { normaliseHash } from "../script/scriptDoc";
import { toVaultDate, toVaultMinute } from "../time/dates";
import { LANGUAGE_LABELS, NO_RUN_FLAG, type RunLanguage } from "./block";
import type { RunOutcome } from "./outcome";

export interface ObservedRun {
  /** The note the block lives in, as a wikilink or a path. */
  source: string;
  /** `python #2` — where the block was when it ran. A hint, not an identity. */
  block: string;
  language: RunLanguage;
  /** The code that ran, verbatim. Hashed, and kept in the record's body. */
  script: string;
  /** sha256 of `script`, computed by the caller. */
  scriptHash: string;
  outcome: RunOutcome;
  /** Epoch ms the process started. */
  started: number;
  actor: string;
  /** Optional links a person supplied in the run dialog. */
  request: string;
  inputs: { dataset: string; version: string }[];
  variables: string[];
}

export interface ObservedRunPlan {
  id: string;
  frontmatter: Record<string, unknown>;
  /** The record's prose, with the executed code in it. */
  body: string;
  /** Things this record cannot answer, said out loud rather than assumed away. */
  weaknesses: string[];
  /** One line for the ledger: ids and counts, no content (rule 7). */
  auditDetail: string;
}

export function planObservedRun(input: { run: ObservedRun; sequence: number }): ObservedRunPlan {
  const { run } = input;
  const id = runId(run.started, input.sequence);
  const weaknesses: string[] = [];

  const hash = normaliseHash(run.scriptHash);
  const inputs = run.inputs
    .map((entry) => ({ dataset: entry.dataset.trim(), version: entry.version.trim() }))
    .filter((entry) => entry.dataset !== "");

  if (inputs.length === 0) {
    weaknesses.push(
      "No input dataset and version recorded, so these outputs cannot be tied to a particular extract. The code and the interpreter are pinned; the data is not.",
    );
  } else if (inputs.some((entry) => entry.version === "")) {
    weaknesses.push("An input has no version, so the record cannot say which extract it saw.");
  }
  if (run.outcome.interpreter === "") {
    weaknesses.push("The interpreter did not report its version, so the record cannot say what the code ran under.");
  }
  if (run.outcome.truncated) {
    weaknesses.push("The output was longer than the limit and was cut, so what is kept is not the whole of what was printed.");
  }

  const frontmatter: Record<string, unknown> = {
    type: "run",
    id,
    script: run.source,
    // Where the block was in the note when it ran. `script_hash` is the
    // identity; this is so a person can find it again today, before the note
    // is edited and the count changes.
    block: run.block,
    language: run.language,
    started: toVaultMinute(run.started),
    duration_s: Math.round((run.outcome.durationMs / 1000) * 10) / 10,
    exit: run.outcome.exit,
    // Observed, not reported. The plugin spawned this process and watched it
    // end, which is why there is no `recorded_by` here.
    ran_by: run.actor,
    ran: toVaultDate(run.started),
  };

  if (run.outcome.interpreter !== "") frontmatter["interpreter"] = run.outcome.interpreter;
  if (hash !== "") frontmatter["script_hash"] = `sha256:${hash}`;
  if (run.request.trim() !== "") frontmatter["request"] = run.request.trim();
  if (inputs.length > 0) {
    frontmatter["inputs"] = inputs.map((entry) => {
      const record: Record<string, unknown> = { dataset: entry.dataset };
      if (entry.version !== "") record["version"] = entry.version;
      return record;
    });
  }
  if (run.variables.length > 0) frontmatter["variables"] = [...run.variables];
  if (run.outcome.figures.length > 0) {
    frontmatter["outputs"] = run.outcome.figures.map((path) => ({ kind: "plot", path }));
  }

  return {
    id,
    frontmatter,
    body: renderBody(id, run),
    weaknesses,
    auditDetail: `${id}; ${run.language}; exit ${run.outcome.exit}; ${run.outcome.figures.length} figure${run.outcome.figures.length === 1 ? "" : "s"}${hash === "" ? "; no script hash" : ""}`,
  };
}

/**
 * The record's body, carrying the code that ran.
 *
 * §5.12 leans everything on `script_hash` naming "what actually ran, not what
 * the note says now" — but a hash on its own only proves a mismatch. It cannot
 * show you the code once the note has moved on. The block is small and it is
 * already in the vault, so the record keeps a verbatim copy and the hash
 * becomes checkable rather than merely comparable.
 *
 * The copy is fenced `no-run`, so the archive of an old run is not itself
 * offered as something to execute.
 */
function renderBody(id: string, run: ObservedRun): string {
  const lines = [
    `# ${id}`,
    "",
    `Provenance record for a ${LANGUAGE_LABELS[run.language]} block in ${run.source}, run by this plugin (§5.12).`,
    "",
    "Observed, not reported: the plugin started this process and watched it end.",
    "The code below is the copy that ran, kept verbatim so `script_hash` can be",
    "checked and not merely compared.",
    "",
    renderFence(run.script, run.language, NO_RUN_FLAG),
    "",
  ];
  return lines.join("\n");
}

/** `python #2` — how a block is named on the record and in the run dialog. */
export function blockLabel(language: RunLanguage, ordinal: number): string {
  return `${language} #${ordinal}`;
}
