/**
 * Creating a project (CLAUDE.md §5.15).
 *
 * Identity follows §5.2 exactly: `uid` is a ULID and is what anything durable
 * points at; `id` is the human label `PRJ-YYYY-NNN`, allocated by scanning what
 * exists, which works for one allocator and is why nothing depends on it.
 * `nextRequestId` already does that scan and does not care about the prefix, so
 * this module reuses it rather than shipping a second allocator that could
 * drift from the first.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AuditEntry } from "../audit/ledger";
import { ulid } from "../id/ulid";
import { nextRequestId, type IdOptions } from "../request/create";
import type { WorkflowSpec } from "../request/workflow";
import { toVaultDate, toVaultMinute } from "../time/dates";

export const PROJECT_TYPE = "project";
export const PROJECT_ID_PREFIX = "PRJ";

/** The next free `PRJ-YYYY-NNN`. One allocator, shared with requests. */
export function nextProjectId(
  existingIds: readonly string[],
  year: number,
  options: Omit<IdOptions, "prefix"> = {},
): string {
  return nextRequestId(existingIds, year, { ...options, prefix: PROJECT_ID_PREFIX });
}

export interface NewProjectInput {
  spec: WorkflowSpec;
  now: number;
  actor: string;
  /** The human label. Allocate it with `nextProjectId`. */
  id: string;
  title: string;

  /** Defaults to a fresh ULID; injectable so tests are deterministic. */
  uid?: string;
  /** Defaults to the first stage the spec declares. */
  stage?: string;

  owner?: string;
  sponsor?: string;
  hat?: string;
  /** Epoch ms. Defaults to `now`. */
  started?: number;
  /** Epoch ms. Left unset when absent — a made-up deadline is worse than none. */
  due?: number;
  effortEstimateHours?: number;
}

export interface NewProject {
  /** Filename within the projects folder, extension included. */
  filename: string;
  frontmatter: Record<string, unknown>;
  audit: AuditEntry[];
}

/**
 * Build a new project note.
 *
 * Only fields the caller supplied are written, on the same reasoning as
 * `newRequest`: an empty `sponsor:` invites a reader to believe the question
 * was asked and answered with nothing.
 *
 * `milestones` and `deliverables` start as empty lists rather than absent, so
 * the shape a person is meant to fill in is visible in the note from the first
 * day — that is the difference between a contract and a guess.
 */
export function newProject(input: NewProjectInput): NewProject {
  const { spec, now, actor } = input;
  const stage = input.stage ?? spec.stages[0]?.id ?? "";
  const uid = input.uid ?? ulid(now);
  const started = input.started ?? now;

  const frontmatter: Record<string, unknown> = {
    type: PROJECT_TYPE,
    uid,
    id: input.id,
    title: input.title.trim(),
    workflow: spec.id,
    workflow_version: spec.version,
    stage,
    started: toVaultDate(started),
  };

  const optional: [string, unknown][] = [
    ["hat", input.hat?.trim()],
    ["owner", input.owner?.trim()],
    ["sponsor", input.sponsor?.trim()],
    ["due", input.due === undefined ? undefined : toVaultDate(input.due)],
    ["effort_estimate_hours", input.effortEstimateHours],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== "") frontmatter[key] = value;
  }

  frontmatter["studies"] = [];
  frontmatter["requests"] = [];
  frontmatter["milestones"] = [];
  frontmatter["deliverables"] = [];
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
    ],
  };
}

/** The note body a new project starts with. Prose is never rewritten by the plugin. */
export function newProjectBody(input: Pick<NewProjectInput, "title">): string {
  return [
    `# ${input.title.trim()}`,
    "",
    "## Why this exists",
    "",
    "## Notes",
    "",
  ].join("\n");
}
