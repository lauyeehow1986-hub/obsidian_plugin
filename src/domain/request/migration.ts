/**
 * Workflow migration (CLAUDE.md §5.2).
 *
 * > On load, any note whose `workflow_version` is behind the spec is
 * > quarantined from stage actions and listed in a **migration view**: old
 * > stage → proposed new stage, editable, applied in bulk, each mapping written
 * > to `history` and the audit ledger. Never silently remap; never silently
 * > leave a note pointing at a stage that no longer exists.
 *
 * The quarantine itself lives in `transition.ts`, which refuses a stage change
 * on a stranded note. This module is the way out of it.
 *
 * Three deliberate positions:
 *
 *  - **Migration does not evaluate governance gates.** A gate guards *entry* to
 *    a stage as a governance decision; a migration relabels a stage the request
 *    is already in. Running gates here would strand a request forever whenever
 *    a gate was added after it arrived, and a gate cannot be satisfied
 *    retrospectively anyway. What migration will not do is let the stage be
 *    changed to something unjustified without saying so — see the next point.
 *  - **Anything the spec did not propose needs a typed reason**, logged. The
 *    spec proposes a target only when the stage id is still live (unchanged) or
 *    `retired:` maps it. Everything else is the user's judgement call, and a
 *    judgement call with no recorded reason is exactly what §5.6 exists to
 *    prevent — otherwise migration becomes a way to walk a request into
 *    `delivered` with no trace.
 *  - **A note written under a newer spec is never rewritten.** Same reasoning as
 *    the settings loader: writing our older shape over a newer one is data loss.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AuditEntry } from "../audit/ledger";
import { toVaultDate, toVaultMinute } from "../time/dates";
import type { WorkflowNote } from "./request";
import type { FrontmatterPatch } from "./transition";
import { resolveStage, type StageSpec, type WorkflowSpec } from "./workflow";

/** Why a note cannot be driven under the current spec. */
export type MigrationReason =
  | "version-missing"
  | "version-behind"
  | "version-ahead"
  | "stage-retired"
  | "stage-unknown";

/** Where the proposed target stage came from. */
export type ProposalSource =
  /** The stage id is still live; only the version needs bumping. */
  | "unchanged"
  /** The spec's `retired:` map names the replacement. */
  | "retired-map"
  /** The spec does not say. The user must choose, with a reason. */
  | "none";

export interface MigrationItem<T extends WorkflowNote = WorkflowNote> {
  request: T;
  fromVersion: number | null;
  toVersion: number;
  fromStage: string;
  /** The stage we propose. Empty string when the spec offers no answer. */
  proposedStage: string;
  proposalSource: ProposalSource;
  reasons: MigrationReason[];
  /** Plain English, for the migration view. */
  explanation: string;
  /** True when accepting the proposal still needs a typed reason. */
  requiresReason: boolean;
}

export interface MigrationPlan<T extends WorkflowNote = WorkflowNote> {
  spec: WorkflowSpec;
  /** Stranded notes, worst first: no proposal, then remapped, then version-only. */
  items: MigrationItem<T>[];
  /** Notes recording a version *newer* than the spec. Listed, never rewritten. */
  ahead: T[];
}

/** True when the note and the spec disagree enough to block stage actions. */
export function isStranded(request: WorkflowNote, spec: WorkflowSpec): boolean {
  if (request.workflowVersion !== spec.version) return true;
  return !spec.stages.some((stage) => stage.id === request.stage);
}

/** A live stage id — not one that only resolves through `retired:`. */
function liveStage(spec: WorkflowSpec, stageId: string): StageSpec | null {
  return spec.stages.find((stage) => stage.id === stageId) ?? null;
}

function stageLabel(spec: WorkflowSpec, stageId: string): string {
  return liveStage(spec, stageId)?.label ?? stageId;
}

/** Describe one stranded note: what is wrong, and what we propose about it. */
export function describeMigration<T extends WorkflowNote>(
  request: T,
  spec: WorkflowSpec,
): MigrationItem<T> {
  const reasons: MigrationReason[] = [];
  const from = request.stage;

  if (request.workflowVersion === null) reasons.push("version-missing");
  else if (request.workflowVersion < spec.version) reasons.push("version-behind");
  else if (request.workflowVersion > spec.version) reasons.push("version-ahead");

  let proposedStage = "";
  let proposalSource: ProposalSource = "none";

  if (liveStage(spec, from) !== null) {
    proposedStage = from;
    proposalSource = "unchanged";
  } else {
    const mapped = spec.retired[from];
    if (mapped !== undefined && liveStage(spec, mapped) !== null) {
      proposedStage = mapped;
      proposalSource = "retired-map";
      reasons.push("stage-retired");
    } else {
      reasons.push("stage-unknown");
    }
  }

  const sentences: string[] = [];
  if (reasons.includes("version-missing")) {
    sentences.push(`The note records no \`workflow_version\`; the spec is v${spec.version}.`);
  } else if (reasons.includes("version-behind")) {
    sentences.push(
      `Last valid under v${request.workflowVersion}; the spec is now v${spec.version}.`,
    );
  } else if (reasons.includes("version-ahead")) {
    sentences.push(
      `The note records v${request.workflowVersion}, which is newer than the installed spec (v${spec.version}).`,
    );
  }

  if (proposalSource === "retired-map") {
    sentences.push(
      `Stage "${from}" was retired; the spec maps it to "${stageLabel(spec, proposedStage)}".`,
    );
  } else if (proposalSource === "none") {
    sentences.push(
      `Stage "${from || "(none)"}" is not in the spec and nothing under \`retired:\` maps it. Choose where it belongs.`,
    );
  } else if (reasons.length > 0) {
    sentences.push(`Stage "${stageLabel(spec, from)}" still exists, so only the version changes.`);
  }

  return {
    request,
    fromVersion: request.workflowVersion,
    toVersion: spec.version,
    fromStage: from,
    proposedStage,
    proposalSource,
    reasons,
    explanation: sentences.join(" "),
    // Accepting a proposal the spec itself makes is not a judgement call.
    // Having no proposal is.
    requiresReason: proposalSource === "none",
  };
}

/** Rank for the migration view: the notes needing a decision come first. */
function itemOrder(item: MigrationItem): number {
  if (item.proposalSource === "none") return 0;
  if (item.proposalSource === "retired-map") return 1;
  return 2;
}

/**
 * Everything stranded under one spec. `requests` should already be the notes
 * this spec governs; a note naming a workflow we do not have is a different
 * problem and is not this function's to report.
 */
export function planMigration<T extends WorkflowNote>(
  requests: readonly T[],
  spec: WorkflowSpec,
): MigrationPlan<T> {
  const items: MigrationItem<T>[] = [];
  const ahead: T[] = [];

  for (const request of requests) {
    if (!isStranded(request, spec)) continue;
    const item = describeMigration(request, spec);
    if (item.reasons.includes("version-ahead")) ahead.push(request);
    else items.push(item);
  }

  items.sort((a, b) => {
    const rank = itemOrder(a) - itemOrder(b);
    if (rank !== 0) return rank;
    return (a.request.id || a.request.uid).localeCompare(b.request.id || b.request.uid);
  });

  return { spec, items, ahead };
}

export interface MigrationCommand {
  spec: WorkflowSpec;
  request: WorkflowNote;
  /** The stage the note will carry afterwards. Must be a live stage id. */
  toStage: string;
  actor: string;
  now: number;
  /** Required when `toStage` is not what the spec proposed. */
  reason?: string;
}

export interface MigrationEffect {
  patch: FrontmatterPatch;
  audit: AuditEntry[];
  item: MigrationItem;
  /** True when the note's stage id actually changed, not just its version. */
  remapped: boolean;
}

export class MigrationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRefused";
  }
}

/**
 * Produce the effects of migrating one note. Throws `MigrationRefused` rather
 * than writing something the engine could not defend afterwards.
 */
export function applyMigration(command: MigrationCommand): MigrationEffect {
  const { spec, request, toStage, actor, now } = command;
  const reason = command.reason?.trim() ?? "";

  if (request.workflow !== "" && request.workflow !== spec.id) {
    throw new MigrationRefused(
      `This request follows workflow "${request.workflow}", not "${spec.id}". Migrating it under the wrong spec would mean nothing.`,
    );
  }

  const item = describeMigration(request, spec);

  if (item.reasons.includes("version-ahead")) {
    throw new MigrationRefused(
      `This request records workflow v${request.workflowVersion}, which is newer than the installed spec (v${spec.version}). ` +
        "Install the newer spec rather than writing an older shape over it.",
    );
  }

  const target = liveStage(spec, toStage);
  if (target === null) {
    throw new MigrationRefused(
      `There is no stage "${toStage}" in workflow "${spec.id}" v${spec.version}.` +
        (resolveStage(spec, toStage) !== null
          ? " It is listed under `retired:`, so it cannot be migrated *into*."
          : ""),
    );
  }

  // Never silently remap (§5.2). A target the spec did not propose is the
  // user's call and has to be recorded as one.
  if (target.id !== item.proposedStage && reason === "") {
    throw new MigrationRefused(
      item.proposalSource === "none"
        ? `Nothing in the spec says where "${item.fromStage || "(none)"}" should go, so moving it to "${target.label}" needs a typed reason.`
        : `The spec proposes "${stageLabel(spec, item.proposedStage)}", not "${target.label}". Overriding the proposal needs a typed reason.`,
    );
  }

  const remapped = target.id !== item.fromStage;

  const set: Record<string, unknown> = {
    workflow_version: spec.version,
    stage: target.id,
  };
  // Only fill in `workflow` when the note leaves it out — a note that names a
  // different workflow was refused above, and one that already names this spec
  // does not need the key rewritten.
  if (request.workflow === "") set["workflow"] = spec.id;

  const detail =
    `${spec.id} v${request.workflowVersion ?? "unset"}→v${spec.version}; ` +
    (remapped ? `${item.fromStage || "(none)"}→${target.id}` : "stage unchanged") +
    (reason === "" ? "" : `; reason: ${reason}`);

  const audit: AuditEntry[] = [
    {
      ts: toVaultMinute(now),
      actor,
      action: "schema-migration",
      subject: request.id || request.uid,
      detail,
    },
  ];

  const patch: FrontmatterPatch = { set, unset: [] };

  // A relabel is written to `history` so the note still reads as a full record
  // of itself. `migration: true` is what keeps it out of the dwell maths — see
  // `effectiveHistory` in `dwell.ts`. A version-only bump moved nothing, so it
  // writes no history entry; the ledger carries it.
  if (remapped) {
    patch.appendHistory = {
      at: toVaultDate(now),
      to: target.id,
      by: actor,
      migration: true,
      from: item.fromStage,
    };
  }

  return { patch, audit, item, remapped };
}
