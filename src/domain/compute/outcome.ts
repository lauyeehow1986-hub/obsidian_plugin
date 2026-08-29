/**
 * What came back from a run, and how much of it is kept (§7 F1).
 *
 * The interesting decisions here are about *limits*. A block with a loop that
 * prints can produce megabytes in a second, and all of it would otherwise go
 * into a note, into the index, and into every export of that note thereafter.
 * So output is capped — and, because a cap that silently drops the end of a
 * traceback is worse than no output at all, the middle is what goes, with the
 * omission stated in the text.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isRunExit, type RunExit } from "../script/runRecord";

export interface RunOutcome {
  exit: RunExit;
  /** The process's own status, or null when it was killed before returning one. */
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Vault paths of the figures kept, in the order the harness numbered them. */
  figures: string[];
  /** The interpreter as it identified itself, for §5.12's `interpreter:`. */
  interpreter: string;
  /** True when either stream was cut. Said out loud in the note. */
  truncated: boolean;
}

/**
 * How a process ending maps onto §5.12's four words.
 *
 * `killed` and `timeout` are kept apart deliberately: one is a person deciding
 * they had seen enough, the other is the machine deciding for them, and a run
 * record that conflated the two would lose the difference between "I stopped
 * it" and "it never finished".
 */
export function classifyExit(input: {
  code: number | null;
  timedOut: boolean;
  stopped: boolean;
  spawnFailed: boolean;
}): RunExit {
  if (input.timedOut) return "timeout";
  if (input.stopped) return "killed";
  if (input.spawnFailed) return "error";
  return input.code === 0 ? "ok" : "error";
}

export function isFailure(exit: RunExit): boolean {
  return isRunExit(exit) && exit !== "ok";
}

/**
 * Trim a stream to a byte budget, keeping both ends.
 *
 * Head and tail rather than one or the other: the head says what the block set
 * out to do and the tail says where it stopped, and for a traceback the tail is
 * the whole message. Cutting on line boundaries keeps the result readable.
 */
export function capOutput(text: string, limit: number): { text: string; cut: boolean } {
  if (limit <= 0 || text.length <= limit) return { text, cut: false };

  const headBudget = Math.floor(limit * 0.6);
  const tailBudget = limit - headBudget;

  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  const omitted = text.length - head.length - tail.length;

  return {
    text: `${trimToLine(head, "end")}\n\n… ${omitted.toLocaleString("en-GB")} characters omitted …\n\n${trimToLine(tail, "start")}`,
    cut: true,
  };
}

function trimToLine(part: string, side: "start" | "end"): string {
  if (side === "end") {
    const cut = part.lastIndexOf("\n");
    return cut > 0 ? part.slice(0, cut) : part;
  }
  const cut = part.indexOf("\n");
  return cut >= 0 ? part.slice(cut + 1) : part;
}

/** `0.4 s`, `1 m 12 s` — §6's rule that durations are human, at run scale. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds - minutes * 60)} s`;
}

export const EXIT_LABELS: Record<RunExit, string> = {
  ok: "ok",
  error: "error",
  timeout: "timed out",
  killed: "stopped",
};

/**
 * The banner line at the top of the output block.
 *
 * Everything an eye needs before reading a word of the output: which run
 * record this belongs to, what ran it, how long it took, and how it ended.
 */
export function outcomeSummary(input: {
  runId: string;
  outcome: RunOutcome;
  at: string;
}): string {
  const { outcome } = input;
  const parts = [
    input.runId,
    outcome.interpreter === "" ? "unknown interpreter" : outcome.interpreter,
    formatDuration(outcome.durationMs),
    EXIT_LABELS[outcome.exit],
  ];
  if (outcome.figures.length > 0) {
    parts.push(`${outcome.figures.length} figure${outcome.figures.length === 1 ? "" : "s"}`);
  }
  return `${input.at} · ${parts.join(" · ")}`;
}

/**
 * A one-line notice, and the ledger's `detail` column.
 *
 * Rule 7: ids and counts, never content. The block's output may hold anything
 * the data holds, so none of it goes near a console or a ledger row.
 */
export function outcomeDetail(runId: string, outcome: RunOutcome): string {
  const bits = [
    runId,
    `exit ${outcome.exit}`,
    formatDuration(outcome.durationMs),
    `${outcome.figures.length} figure${outcome.figures.length === 1 ? "" : "s"}`,
  ];
  if (outcome.truncated) bits.push("output truncated");
  return bits.join("; ");
}
