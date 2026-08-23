/**
 * The publication stage machine (CLAUDE.md §7 B5, §5.4).
 *
 * Same two-function shape as the request engine (`request/transition.ts`):
 * `evaluate` decides and explains without touching anything, `apply` produces
 * the frontmatter patch and the audit entries as data for the vault layer to
 * write. That split is what lets every refusal path be unit-tested.
 *
 * **Deliberately no governance gates.** A request gate exists because releasing
 * identifiable data without a signed DUA is a breach; a manuscript moving from
 * `revision` to `accepted` is a journal's decision, not ours to withhold. The
 * stages here are recorded, not enforced. Refusals are structural only — the
 * note and the vocabulary disagree — and none of them is overridable, because
 * there is nothing to override: an unknown stage is a typo, not a judgement.
 *
 * **Where the stage list comes from.** Unlike the eData workflow (§5.2) this is
 * not a spec file the user edits. The ten stages are §5.4's own closed list and
 * the transitions below are what a manuscript can actually do; a journal does
 * not invent an eleventh. If that ever stops being true it becomes a spec file
 * like the workflow, rather than growing stages quietly here.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AuditEntry } from "../audit/ledger";
import { toVaultDate, toVaultMinute } from "../time/dates";
import {
  isPublicationStage,
  stageLabel,
  type PublicationNote,
  type PublicationStage,
} from "./publication";

/**
 * Where each stage can go next.
 *
 * Two entries carry most of the meaning:
 *
 *  - `rejected` is **not** terminal. A rejected manuscript going back to
 *    `revision` or straight out to another journal as `submitted` is the normal
 *    life of a paper, and it is exactly what §5.4's resubmission count is
 *    counting. Closing the door here would make that number always zero.
 *  - `published` is the only stage with nowhere to go. A retraction is a new
 *    kind of event, not a stage, and inventing one to cover it would be the
 *    quiet stage-invention §5.2 warns against.
 */
const NEXT: Record<PublicationStage, readonly PublicationStage[]> = {
  drafting: ["internal-review", "submitted", "shelved"],
  "internal-review": ["drafting", "submitted", "shelved"],
  submitted: ["under-review", "rejected", "drafting", "shelved"],
  "under-review": ["revision", "accepted", "rejected", "shelved"],
  revision: ["submitted", "under-review", "accepted", "rejected", "shelved"],
  accepted: ["in-press", "published", "rejected"],
  "in-press": ["published"],
  published: [],
  rejected: ["revision", "submitted", "drafting", "shelved"],
  shelved: ["drafting", "submitted"],
};

/** The stages a manuscript in `from` may move to. Empty for an unknown stage. */
export function nextStages(from: string): PublicationStage[] {
  return isPublicationStage(from) ? [...NEXT[from]] : [];
}

export type PublicationRefusalKind =
  | "unknown-stage"
  | "unknown-target"
  | "same-stage"
  | "terminal"
  | "not-declared";

export interface PublicationRefusal {
  kind: PublicationRefusalKind;
  message: string;
}

export interface PublicationDecision {
  from: string;
  to: string;
  allowed: boolean;
  refusals: PublicationRefusal[];
  /** Non-blocking notes: a decision date left behind, a journal not recorded. */
  warnings: string[];
}

export interface PublicationTransitionQuery {
  publication: PublicationNote;
  to: string;
  /** Where it is being sent, when the move is a submission elsewhere. */
  journal?: string;
}

/** Stages after which a decision from the journal is what we are waiting for. */
const AWAITS_DECISION: readonly string[] = ["submitted", "under-review"];

/** Decide whether a manuscript may move to `to`, and explain the answer. */
export function evaluatePublicationTransition(
  query: PublicationTransitionQuery,
): PublicationDecision {
  const { publication, to } = query;
  const from = publication.stage;
  const refusals: PublicationRefusal[] = [];
  const warnings: string[] = [];

  const refuse = (kind: PublicationRefusalKind, message: string) =>
    refusals.push({ kind, message });

  if (from === "") {
    refuse("unknown-stage", "This publication has no `stage`.");
  } else if (!isPublicationStage(from)) {
    refuse("unknown-stage", `Stage "${from}" is not one of the publication stages in §5.4.`);
  }
  if (!isPublicationStage(to)) {
    refuse("unknown-target", `There is no publication stage "${to}".`);
  }

  if (isPublicationStage(from) && isPublicationStage(to)) {
    if (from === to) {
      refuse("same-stage", `The manuscript is already ${stageLabel(to).toLowerCase()}.`);
    } else if (NEXT[from].length === 0) {
      refuse("terminal", `"${stageLabel(from)}" is where a manuscript's story ends.`);
    } else if (!NEXT[from].includes(to)) {
      refuse(
        "not-declared",
        `A manuscript does not go from "${stageLabel(from)}" to "${stageLabel(to)}".` +
          ` From here it can go to ${NEXT[from].map(stageLabel).join(", ")}.`,
      );
    }
  }

  const journal = (query.journal ?? "").trim();
  if (AWAITS_DECISION.includes(to) && journal === "" && publication.journal === "") {
    warnings.push(
      "No journal is recorded, so this will not appear in where the department lands.",
    );
  }
  if (!AWAITS_DECISION.includes(to) && publication.decisionDue !== null) {
    warnings.push("`decision_due` still points at the decision that has now arrived.");
  }

  return { from, to, allowed: refusals.length === 0, refusals, warnings };
}

/** A merge-safe description of what to change in frontmatter. */
export interface PublicationPatch {
  set: Record<string, unknown>;
  /** Keys to remove — used when a date stops meaning anything. */
  unset: string[];
  /** Appended to `history`; existing entries are never touched. */
  appendHistory: Record<string, unknown>;
}

export interface PublicationEffect {
  decision: PublicationDecision;
  patch: PublicationPatch;
  audit: AuditEntry[];
}

export interface PublicationTransitionCommand extends PublicationTransitionQuery {
  now: number;
  /** Written to `history[].by` and the ledger's `actor` column. */
  actor: string;
  /** When the journal's answer is expected. `null` clears it. */
  decisionDue?: number | null;
}

export class PublicationRefused extends Error {
  constructor(
    message: string,
    readonly decision: PublicationDecision,
  ) {
    super(message);
    this.name = "PublicationRefused";
  }
}

/**
 * Produce the effects of a stage change.
 *
 * Throws `PublicationRefused` when the move is not allowed — there is no
 * override path, because every refusal here means the note and the stage
 * vocabulary disagree rather than that a rule is inconvenient.
 */
export function applyPublicationTransition(
  command: PublicationTransitionCommand,
): PublicationEffect {
  const { publication, to, now, actor } = command;
  const decision = evaluatePublicationTransition(command);
  if (!decision.allowed) {
    throw new PublicationRefused(decision.refusals.map((r) => r.message).join(" "), decision);
  }

  const set: Record<string, unknown> = { stage: to };
  const unset: string[] = [];
  const history: Record<string, unknown> = { at: toVaultDate(now), to, by: actor };

  const journal = (command.journal ?? "").trim();
  if (journal !== "" && journal !== publication.journal) {
    set["journal"] = journal;
    // Recorded on the entry too, so a resubmission elsewhere keeps both stops.
    history["journal"] = journal;
  }

  // The first submission is when the clock on "time to first decision" starts,
  // and a manuscript that was drafted for a year should not read as if it had
  // been under review all that time. Only set it if it is not already there —
  // a resubmission must not overwrite the original submission date.
  if (to === "submitted" && publication.submitted === null) {
    set["submitted"] = toVaultDate(now);
  }
  if (to === "published" && publication.published === null) {
    set["published"] = toVaultDate(now);
  }

  if (command.decisionDue !== undefined) {
    if (command.decisionDue === null) unset.push("decision_due");
    else set["decision_due"] = toVaultDate(command.decisionDue);
  } else if (!AWAITS_DECISION.includes(to) && publication.decisionDue !== null) {
    // A decision that has arrived is not still due. Left in place it keeps
    // showing up in the briefing as an overdue chase-up that has been answered.
    unset.push("decision_due");
  }

  const audit: AuditEntry[] = [
    {
      ts: toVaultMinute(now),
      actor,
      action: "stage-change",
      subject: publication.id || publication.path,
      detail: `${publication.stage || "(none)"}→${to}${journal === "" ? "" : ` (${journal})`}`,
    },
  ];

  return { decision, patch: { set, unset, appendHistory: history }, audit };
}
