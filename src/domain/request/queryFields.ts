/**
 * Requests as query rows (§7 A2).
 *
 * This is the bridge that earns the query engine its keep. Bases can already
 * show `stage` and `due`, because those are stored. It cannot show *dwell*,
 * *bounce count* or *SLA state*, because those exist only once someone has
 * folded the history and compared it to a spec. Exposing them as ordinary
 * fields means a filter, a sort, a group and an aggregate all work on them
 * without the query engine knowing anything about requests.
 *
 * Every computed field is marked as such, so the field picker can say where a
 * number came from — a governance instrument should not blur the line between
 * what a note claims and what we worked out.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { FieldDef, Row } from "../query/model";
import { DAY_MS } from "../time/dates";
import type { RequestMetrics } from "./dwell";
import type { RequestNote } from "./request";
import type { WorkflowSpec } from "./workflow";

export const REQUEST_ROW_TYPE = "scdb-request";

export const HATS = ["hod", "biostat", "research-core"] as const;
export const IDENTIFIER_SCOPES = ["none", "indirect", "direct"] as const;
export const SLA_STATES = ["no-target", "on-track", "at-risk", "breached"] as const;

/**
 * The field catalogue.
 *
 * Order matters twice: it is the order of the field picker, and the first
 * handful are the default columns of a table with none chosen.
 */
export const REQUEST_FIELDS: readonly FieldDef[] = [
  { id: "id", label: "ID", kind: "text" },
  { id: "title", label: "Title", kind: "text" },
  { id: "stage_label", label: "Stage", kind: "text", computed: true },
  { id: "sla_state", label: "SLA", kind: "text", computed: true, options: SLA_STATES },
  { id: "dwell", label: "In stage", kind: "duration", computed: true },
  { id: "age", label: "Age", kind: "duration", computed: true },
  { id: "blocked_on", label: "Waiting on", kind: "link" },
  { id: "due", label: "Due", kind: "date" },

  { id: "stage", label: "Stage id", kind: "text" },
  { id: "blocked_for", label: "Blocked for", kind: "duration", computed: true },
  { id: "blocked_since", label: "Blocked since", kind: "date" },
  { id: "bounces", label: "Bounces", kind: "number", computed: true },
  { id: "revisits", label: "Revisits", kind: "number", computed: true },
  { id: "turnaround", label: "Turnaround", kind: "duration", computed: true },
  { id: "completed", label: "Complete", kind: "boolean", computed: true },
  { id: "days_to_due", label: "Days to due", kind: "number", computed: true },
  { id: "over_by", label: "Over target by", kind: "duration", computed: true },
  { id: "stage_target_days", label: "Stage target (days)", kind: "number", computed: true },

  { id: "requester", label: "Requester", kind: "link" },
  { id: "assignee", label: "Assignee", kind: "link" },
  { id: "study", label: "Study", kind: "link" },
  { id: "hat", label: "Hat", kind: "text", options: HATS },
  { id: "priority", label: "Priority", kind: "text" },
  { id: "received", label: "Received", kind: "date" },
  { id: "sla_days", label: "SLA days", kind: "number" },
  { id: "effort_estimate_hours", label: "Estimate (hours)", kind: "number" },

  { id: "identifiers", label: "Identifiers", kind: "text", options: IDENTIFIER_SCOPES },
  { id: "irb_ref", label: "IRB ref", kind: "text" },
  { id: "irb_expiry", label: "IRB expiry", kind: "date" },
  { id: "evidence_count", label: "Evidence records", kind: "number", computed: true },
  { id: "outputs_count", label: "Outputs", kind: "number", computed: true },

  { id: "external_ref", label: "External ref", kind: "text" },
  { id: "last_reconciled", label: "Last reconciled", kind: "date" },
  {
    id: "unreconciled_days",
    label: "Days unreconciled",
    kind: "number",
    computed: true,
  },

  { id: "workflow", label: "Workflow", kind: "text" },
  { id: "workflow_version", label: "Workflow version", kind: "number" },
  { id: "stranded", label: "Awaiting migration", kind: "boolean", computed: true },
  { id: "problem_count", label: "Problems", kind: "number", computed: true },
  { id: "uid", label: "UID", kind: "text" },
];

function governance(request: RequestNote): Record<string, unknown> {
  const raw = request.raw["governance"];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function outputCount(request: RequestNote): number {
  const raw = request.raw["outputs"];
  return Array.isArray(raw) ? raw.length : 0;
}

/**
 * Whether the note is quarantined from stage actions (§5.2).
 *
 * Repeated from `migration.ts` rather than imported, because that module's
 * `isStranded` takes a spec and this must answer for a request whose spec is
 * missing entirely — an unknown workflow is stranded too.
 */
function stranded(request: RequestNote, spec: WorkflowSpec | null): boolean {
  if (!spec) return true;
  if (request.workflowVersion !== spec.version) return true;
  return !spec.stages.some((stage) => stage.id === request.stage);
}

export interface RequestRowInput {
  /** Vault path; the row's stable key. */
  key: string;
  request: RequestNote;
  metrics: RequestMetrics;
  /** The governing spec, or null when the note names one we do not have. */
  spec: WorkflowSpec | null;
  /** What the parse could not read, so it is filterable rather than buried. */
  problems?: readonly string[];
  now: number;
}

export function requestRow(input: RequestRowInput): Row {
  const { request, metrics, spec, now } = input;
  const gov = governance(request);
  const stage = spec?.stages.find((entry) => entry.id === request.stage) ?? null;
  const sla = metrics.stageSla.state === "no-target" ? metrics.dueSla : metrics.stageSla;

  return {
    key: input.key,
    type: REQUEST_ROW_TYPE,
    fields: {
      uid: request.uid,
      id: request.id,
      title: request.title,
      external_ref: request.externalRef,
      last_reconciled: request.lastReconciled,
      unreconciled_days:
        request.lastReconciled === null
          ? null
          : Math.floor((now - request.lastReconciled) / DAY_MS),

      workflow: request.workflow,
      workflow_version: request.workflowVersion,
      stage: request.stage,
      // Falls back to the raw id so a stranded request is still legible.
      stage_label: stage?.label ?? request.stage,
      stranded: stranded(request, spec),

      blocked_on: request.blockedOn,
      blocked_since: request.blockedSince,
      blocked_for: metrics.blockedForMs,

      requester: request.requester,
      assignee: request.assignee,
      study: request.study,
      hat: request.hat,
      priority: request.priority,

      received: request.received,
      due: request.due,
      days_to_due: request.due === null ? null : Math.floor((request.due - now) / DAY_MS),
      sla_days: request.slaDays,
      stage_target_days: metrics.stageSla.targetDays,
      effort_estimate_hours: request.effortEstimateHours,

      dwell: metrics.currentDwellMs,
      age: metrics.totalAgeMs,
      turnaround: metrics.turnaroundMs,
      completed: metrics.completed,
      bounces: metrics.bounceCount,
      revisits: metrics.revisitCount,
      sla_state: sla.state,
      // Zero unless breached, and null when there is nothing to breach — an
      // absent target must not aggregate as "0 days over".
      over_by: sla.targetDays === null ? null : sla.overByMs,

      identifiers: gov["identifiers"] ?? null,
      irb_ref: gov["irb_ref"] ?? null,
      irb_expiry: gov["irb_expiry"] ?? null,
      evidence_count: request.evidence.length,
      outputs_count: outputCount(request),

      problem_count: (input.problems?.length ?? 0) + metrics.problems.length,
    },
  };
}
