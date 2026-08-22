/**
 * Creating a request (CLAUDE.md §5.1, the intake command).
 *
 * Identity is deliberately in two parts. `uid` is a ULID: immutable, never
 * reused, collision-free without coordination, and what every machine
 * reference points at. `id` is the human label `REQ-YYYY-NNN`, allocated by
 * scanning what already exists — which works for exactly one person, and is
 * why nothing durable is allowed to depend on it.
 *
 * Pure module: no Obsidian, no Node. The caller supplies the existing ids.
 */

import type { AuditEntry } from "../audit/ledger";
import { ulid } from "../id/ulid";
import { toVaultDate, toVaultMinute } from "../time/dates";
import type { WorkflowSpec } from "./workflow";

export const DEFAULT_ID_PREFIX = "REQ";

/** `REQ-2026-014` and, once a second person is added, `REQ-2026-YH-014`. */
function idPattern(prefix: string, year: number, owner: string): RegExp {
  const scope = owner === "" ? "" : `${escapeForRegex(owner)}-`;
  return new RegExp(`^${escapeForRegex(prefix)}-${year}-${scope}(\\d+)$`, "i");
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface IdOptions {
  prefix?: string;
  /** Owner segment, empty until a second person allocates ids in the same vault. */
  owner?: string;
  /** How many digits to pad to. */
  width?: number;
}

/**
 * The next free human label for `year`.
 *
 * Scanning for the highest number is safe for a single allocator and unsafe the
 * moment there are two — two people creating a request at the same time both
 * get `-014` and both claim the same filename. That is a known limit, not an
 * oversight: `uid` exists so nothing breaks when the labels collide, and the
 * `owner` segment exists so the labels stop colliding when the team grows.
 */
export function nextRequestId(
  existingIds: readonly string[],
  year: number,
  options: IdOptions = {},
): string {
  const prefix = options.prefix ?? DEFAULT_ID_PREFIX;
  const owner = (options.owner ?? "").trim();
  const width = options.width ?? 3;
  const pattern = idPattern(prefix, year, owner);

  let highest = 0;
  for (const id of existingIds) {
    const match = pattern.exec(id.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  const scope = owner === "" ? "" : `${owner}-`;
  return `${prefix}-${year}-${scope}${String(highest + 1).padStart(width, "0")}`;
}

export interface NewRequestInput {
  spec: WorkflowSpec;
  now: number;
  actor: string;
  /** The human label. Allocate it with `nextRequestId`. */
  id: string;
  title: string;

  /** Defaults to a fresh ULID; injectable so tests are deterministic. */
  uid?: string;
  /** Defaults to the first stage the spec declares. */
  stage?: string;

  requester?: string;
  study?: string;
  hat?: string;
  assignee?: string;
  priority?: string;
  externalRef?: string;
  /** Epoch ms. Defaults to `now`. */
  received?: number;
  /** Epoch ms. Left unset when absent — a made-up deadline is worse than none. */
  due?: number;
  slaDays?: number;
  effortEstimateHours?: number;
  identifiers?: "none" | "indirect" | "direct";
}

export interface NewRequest {
  /** Filename within the requests folder, extension included. */
  filename: string;
  frontmatter: Record<string, unknown>;
  audit: AuditEntry[];
}

/**
 * Build a new request note. Only fields the caller actually supplied are
 * written: an empty `study:` key invites a reader to think the field was
 * considered and left blank.
 */
export function newRequest(input: NewRequestInput): NewRequest {
  const { spec, now, actor } = input;
  const stage = input.stage ?? spec.stages[0]?.id ?? "";
  const uid = input.uid ?? ulid(now);
  const received = input.received ?? now;

  const frontmatter: Record<string, unknown> = {
    type: "scdb-request",
    uid,
    id: input.id,
    title: input.title.trim(),
    workflow: spec.id,
    workflow_version: spec.version,
    stage,
    received: toVaultDate(received),
  };

  const optional: [string, unknown][] = [
    ["external_ref", input.externalRef?.trim()],
    ["requester", input.requester?.trim()],
    ["study", input.study?.trim()],
    ["hat", input.hat?.trim()],
    ["assignee", input.assignee?.trim()],
    ["priority", input.priority?.trim()],
    ["due", input.due === undefined ? undefined : toVaultDate(input.due)],
    ["sla_days", input.slaDays],
    ["effort_estimate_hours", input.effortEstimateHours],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== "") frontmatter[key] = value;
  }

  // Governance starts explicit rather than absent: "we have not decided the
  // identifier scope" is a state the gates need to be able to see.
  frontmatter["governance"] = { identifiers: input.identifiers ?? "none" };
  frontmatter["evidence"] = [];
  frontmatter["outputs"] = [];
  frontmatter["history"] = [{ at: toVaultDate(now), to: stage, by: actor }];

  return {
    filename: `${input.id}.md`,
    frontmatter,
    audit: [
      {
        ts: toVaultMinute(now),
        actor,
        action: "stage-change",
        subject: input.id,
        detail: `(new)→${stage}`,
      },
      // The identifier scope is a governance field, so setting it is logged
      // from the very first entry rather than only when it later changes.
      {
        ts: toVaultMinute(now),
        actor,
        action: "identifier-scope",
        subject: input.id,
        detail: `identifiers: ${input.identifiers ?? "none"}`,
      },
    ],
  };
}

/** The note body a new request starts with. Prose is never rewritten by the plugin. */
export function newRequestBody(input: Pick<NewRequestInput, "title">): string {
  return [
    `# ${input.title.trim()}`,
    "",
    "## What was asked for",
    "",
    "## Notes",
    "",
  ].join("\n");
}
