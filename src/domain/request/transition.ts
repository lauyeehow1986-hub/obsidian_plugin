/**
 * The transition engine (CLAUDE.md §5.2).
 *
 * Two functions, deliberately split:
 *
 *  - `evaluateTransition` decides, and explains. It never mutates anything, so
 *    the UI can call it on hover to grey out a stage and show why.
 *  - `applyTransition` produces the **effects** — a frontmatter patch and the
 *    audit entries — as data. The vault layer writes them. Keeping the decision
 *    and the writing apart is what lets every refusal path be unit-tested.
 *
 * A refused transition always returns a plain-English reason. Gate refusals are
 * overridable with a typed reason; structural ones (unknown stage, wrong
 * workflow version, leaving a terminal stage) are not — those mean the note and
 * the spec disagree, and overriding would write a request into a state the
 * engine cannot reason about afterwards.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AuditEntry } from "../audit/ledger";
import { gateOverrideEntry } from "../audit/ledger";
import { toVaultDate, toVaultMinute } from "../time/dates";
import { evaluateGatesFor, type GateResult } from "./gates";
import type { RequestNote } from "./request";
import { isTransitionDeclared, resolveStage, type WorkflowSpec } from "./workflow";

export type RefusalKind =
  | "workflow-mismatch"
  | "unknown-workflow"
  | "unknown-stage"
  | "unknown-target"
  | "terminal"
  | "same-stage"
  | "not-declared"
  | "gate";

export interface Refusal {
  kind: RefusalKind;
  message: string;
  /** Only gate refusals may be overridden, and only with a typed reason. */
  overridable: boolean;
  /** Present for `kind: "gate"`. */
  gate?: GateResult;
}

export interface TransitionDecision {
  from: string;
  to: string;
  allowed: boolean;
  refusals: Refusal[];
  /** Every gate guarding `to`, pass or fail, so the UI can show the whole check. */
  gates: GateResult[];
  /** True when the transition could proceed on an override with a typed reason. */
  overridable: boolean;
  /** Non-blocking notes: evidence that is only verbal, a stale reconciliation. */
  warnings: string[];
}

export interface TransitionQuery {
  spec: WorkflowSpec;
  request: RequestNote;
  to: string;
  now: number;
}

/** Decide whether a request may move to `to`, and explain the answer. */
export function evaluateTransition(query: TransitionQuery): TransitionDecision {
  const { spec, request, to, now } = query;
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const from = request.stage;

  const structural = (kind: RefusalKind, message: string) =>
    refusals.push({ kind, message, overridable: false });

  if (request.workflow !== "" && request.workflow !== spec.id) {
    structural(
      "unknown-workflow",
      `This request follows workflow "${request.workflow}", not "${spec.id}".`,
    );
  }

  // Version quarantine (§5.2): a note valid under an older spec must go through
  // the migration view, not be nudged into a stage that may no longer mean the
  // same thing.
  if (request.workflowVersion === null) {
    structural(
      "workflow-mismatch",
      `This request does not record a \`workflow_version\`. Migrate it to v${spec.version} before changing its stage.`,
    );
  } else if (request.workflowVersion !== spec.version) {
    structural(
      "workflow-mismatch",
      `This request was last valid under workflow v${request.workflowVersion}; the spec is now v${spec.version}. Migrate it first.`,
    );
  }

  const currentStage = resolveStage(spec, from);
  const targetStage = resolveStage(spec, to);

  if (from === "") {
    structural("unknown-stage", "This request has no `stage`.");
  } else if (currentStage === null) {
    structural("unknown-stage", `Stage "${from}" is not in workflow "${spec.id}" v${spec.version}.`);
  }
  if (targetStage === null) {
    structural("unknown-target", `There is no stage "${to}" in workflow "${spec.id}".`);
  }

  if (currentStage && targetStage) {
    if (currentStage.id === targetStage.id) {
      structural("same-stage", `The request is already in "${currentStage.label}".`);
    } else if (currentStage.terminal) {
      structural(
        "terminal",
        `"${currentStage.label}" is a terminal stage; a request cannot leave it.`,
      );
    } else if (!isTransitionDeclared(spec, currentStage.id, targetStage.id)) {
      structural(
        "not-declared",
        `The workflow does not allow "${currentStage.label}" → "${targetStage.label}".`,
      );
    }
  }

  // Gates are evaluated even when a structural refusal already applies, so the
  // user sees the whole picture rather than one problem at a time.
  const gates = targetStage ? evaluateGatesFor(spec, request, targetStage.id, now) : [];
  for (const gate of gates) {
    if (!gate.ok) {
      refusals.push({ kind: "gate", message: gate.message, overridable: true, gate });
    }
  }

  for (const record of request.evidence) {
    if (!record.hard && record.via === "verbal") {
      warnings.push(
        `Evidence for "${record.claim}" is verbal only; it does not satisfy a gate on its own.`,
      );
    }
  }
  if (request.externalRef !== "" && request.lastReconciled === null) {
    warnings.push(
      `This request has never been reconciled against ${request.externalRef} in the eData system.`,
    );
  }

  return {
    from,
    to,
    allowed: refusals.length === 0,
    refusals,
    gates,
    overridable: refusals.length > 0 && refusals.every((r) => r.overridable),
    warnings,
  };
}

/** A merge-safe description of what to change in frontmatter. */
export interface FrontmatterPatch {
  set: Record<string, unknown>;
  /** Keys to remove — used when a holdup clears. */
  unset: string[];
  /**
   * Appended to `history`; existing entries are never touched. Omitted when a
   * change writes no history at all — a workflow migration that only bumps
   * `workflow_version` did not move the request anywhere.
   */
  appendHistory?: Record<string, unknown>;
}

export interface TransitionEffect {
  decision: TransitionDecision;
  patch: FrontmatterPatch;
  /** In order. The stage change first, then a row per overridden gate. */
  audit: AuditEntry[];
}

export interface TransitionCommand extends TransitionQuery {
  /** Written to `history[].by` and the ledger's `actor` column. */
  actor: string;
  /** Who the holdup now sits with. `null` clears it, `undefined` leaves it alone. */
  blockedOn?: string | null;
  /** Required to proceed when the only refusals are gate refusals. */
  override?: { reason: string };
}

export class TransitionRefused extends Error {
  constructor(
    message: string,
    readonly decision: TransitionDecision,
  ) {
    super(message);
    this.name = "TransitionRefused";
  }
}

/**
 * Produce the effects of a transition. Throws `TransitionRefused` when the move
 * is not allowed and no valid override was supplied — the caller must have
 * asked `evaluateTransition` first and collected a reason.
 */
export function applyTransition(command: TransitionCommand): TransitionEffect {
  const { spec, request, to, now, actor } = command;
  const decision = evaluateTransition(command);

  const overrideReason = command.override?.reason.trim() ?? "";
  if (!decision.allowed) {
    if (!decision.overridable) {
      throw new TransitionRefused(decision.refusals.map((r) => r.message).join(" "), decision);
    }
    if (overrideReason === "") {
      // §5.6: refusing to give a reason cancels the override. This is the rule
      // that carries most of the audit value, so it is enforced in the engine.
      throw new TransitionRefused(
        "A governance gate refused this transition. Overriding it requires a typed reason.",
        decision,
      );
    }
  }

  const target = resolveStage(spec, to)!;
  const ts = toVaultMinute(now);
  const blockedOn = command.blockedOn;

  const set: Record<string, unknown> = { stage: target.id };
  const unset: string[] = [];
  const historyEntry: Record<string, unknown> = {
    at: toVaultDate(now),
    to: target.id,
    by: actor,
  };

  if (blockedOn !== undefined) {
    if (blockedOn === null || blockedOn.trim() === "") {
      unset.push("blocked_on", "blocked_since");
    } else {
      set["blocked_on"] = blockedOn.trim();
      set["blocked_since"] = toVaultDate(now);
      historyEntry["blocked_on"] = blockedOn.trim();
    }
  }

  const audit: AuditEntry[] = [
    {
      ts,
      actor,
      action: "stage-change",
      subject: request.id || request.uid,
      detail: `${request.stage || "(none)"}→${target.id}`,
    },
  ];

  if (!decision.allowed) {
    for (const refusal of decision.refusals) {
      audit.push(
        gateOverrideEntry({
          ts,
          actor,
          subject: request.id || request.uid,
          gate: refusal.gate?.gate.message ?? refusal.message,
          reason: overrideReason,
        }),
      );
    }
  }

  return { decision, patch: { set, unset, appendHistory: historyEntry }, audit };
}
