/**
 * The diagnostics report (CLAUDE.md §7 A4).
 *
 * The production vault lives on a locked-down laptop with no dev tools. When
 * something is wrong there, the difference between a bug that can be described
 * and one that cannot is whether the plugin can hand over a page of plain text.
 * So the output is markdown, and the acceptance criterion is that it can be
 * pasted into a message unchanged.
 *
 * Two rules shape what goes in it:
 *
 *  - **Probed, not assumed.** A check that reports what the code intends is
 *    worthless. Every entry here is filled in from something that was actually
 *    measured, called or read; anything that could not be is `unavailable` and
 *    says why, rather than quietly reading as healthy.
 *  - **Counts and identifiers, never content** (rule 7). A note that fails
 *    validation is named by its `id` where it has one, and only falls back to a
 *    path when it does not. The report still carries file names, so it warns
 *    about that in its own header rather than leaving the reader to notice.
 *
 * Pure module: no Obsidian, no Node.
 */

/**
 * `unavailable` is deliberately distinct from `problem`.
 *
 * "The interpreter is missing" and "this build cannot look for an interpreter
 * yet" are different facts, and collapsing them into one red mark trains the
 * reader to ignore both.
 */
export type CheckStatus = "ok" | "warn" | "problem" | "unavailable";

export interface Check {
  label: string;
  status: CheckStatus;
  /** One line. Plain English, with the number or version in it. */
  detail: string;
  /** What to do about it. Only where there is something to do. */
  next?: string;
}

export interface ReportSection {
  title: string;
  checks: Check[];
}

export interface DiagnosticsReport {
  /** Local `YYYY-MM-DDTHH:mm`. */
  generatedAt: string;
  sections: ReportSection[];
}

/** Words, not colour and not glyphs alone (§6) — this is going into plain text. */
const WORD: Record<CheckStatus, string> = {
  ok: "ok",
  warn: "check",
  problem: "PROBLEM",
  unavailable: "n/a",
};

export interface Tally {
  ok: number;
  warn: number;
  problem: number;
  unavailable: number;
}

export function tally(report: DiagnosticsReport): Tally {
  const counts: Tally = { ok: 0, warn: 0, problem: 0, unavailable: 0 };
  for (const section of report.sections) {
    for (const check of section.checks) counts[check.status]++;
  }
  return counts;
}

/** One sentence for the notice that follows the report. */
export function summarise(report: DiagnosticsReport): string {
  const counts = tally(report);
  if (counts.problem > 0) {
    return `${counts.problem} problem${counts.problem === 1 ? "" : "s"} found, ${counts.warn} to check.`;
  }
  if (counts.warn > 0) {
    return `Nothing broken; ${counts.warn} thing${counts.warn === 1 ? "" : "s"} to check.`;
  }
  return `All ${counts.ok} checks passed${counts.unavailable > 0 ? `; ${counts.unavailable} not applicable to this build` : ""}.`;
}

/**
 * Render as markdown.
 *
 * A table per section rather than prose: the reader is usually scanning for the
 * one row that is not `ok`, and a table makes that a glance instead of a read.
 */
export function renderReport(report: DiagnosticsReport): string {
  const lines: string[] = [
    "# SCDB Cockpit diagnostics",
    "",
    `Generated ${report.generatedAt}. ${summarise(report)}`,
    "",
    "> This report names notes and folder paths so you can find what it points at.",
    "> It carries no note content. Read it before sending it to anyone.",
    "",
  ];

  for (const section of report.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.checks.length === 0) {
      lines.push("Nothing to report.", "");
      continue;
    }
    lines.push("| | Check | Detail |", "|---|---|---|");
    for (const check of section.checks) {
      lines.push(`| ${WORD[check.status]} | ${cell(check.label)} | ${cell(detailOf(check))} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function detailOf(check: Check): string {
  return check.next === undefined ? check.detail : `${check.detail} ${check.next}`;
}

/** A pipe or a newline in a value would break the row it is in. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Small helper so collectors read as a list of facts rather than object literals. */
export function check(
  label: string,
  status: CheckStatus,
  detail: string,
  next?: string,
): Check {
  return next === undefined ? { label, status, detail } : { label, status, detail, next };
}

/**
 * Grade a workflow spec's problems the way the spec loader graded them.
 *
 * An `error` means the spec was refused and nothing it governs can change
 * stage; a `warning` means it loaded and something is worth a look. Reporting
 * both as a problem told the reader that a placeholder stage with no SLA
 * target was as serious as an unusable workflow, and a report that cries wolf
 * stops being read.
 */
export function specProblemStatus(
  problems: readonly { problem: { severity: "error" | "warning" } }[],
): CheckStatus {
  if (problems.length === 0) return "ok";
  return problems.some((entry) => entry.problem.severity === "error") ? "problem" : "warn";
}
