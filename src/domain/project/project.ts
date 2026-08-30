/**
 * The project note model (CLAUDE.md §5.15).
 *
 * A project is the other shape of work: the governance rollout, the catalogue
 * build, the grant submission — months long, several deliverables, no single
 * requester. It is deliberately **not a new engine**. A project note carries
 * stages, an owner, a due date and a `history`, which is exactly what
 * `transition`, `dwell`, `gates` and `migration` already consume, so those
 * modules are typed against `WorkflowNote` and drive a project unchanged.
 *
 * What this module adds is the two things a request genuinely does not have:
 * milestones, and the `blocked_by` edges between them. `blocked_on` on a
 * request names a *person*; nothing in the model named a *predecessor* until
 * here.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  isRecord,
  num,
  parseEvidence,
  parseHistory,
  str,
  type WorkflowNote,
} from "../request/request";
import { parseTimestamp } from "../time/dates";
import { cycleThrough } from "./milestones";

/**
 * One dated step inside a project.
 *
 * `done` is a date, not a flag: §5.15 declines percent-complete on the grounds
 * that it is a number nobody can defend six months later. A milestone landed
 * on a day or it has not landed.
 */
export interface Milestone {
  /** Short local id, `M1`. Unique within the project; `blocked_by` names these. */
  id: string;
  title: string;
  due: number | null;
  /** When it landed. Null while open. */
  done: number | null;
  /** Milestone ids that must land first. The one primitive the model lacked. */
  blockedBy: string[];
  /** Optional wikilink to an event note, when the date is also a commitment. */
  event: string;
}

export interface Deliverable {
  title: string;
  /** Free text: `diagram`, `report`, `sop`. Whatever the work produces. */
  kind: string;
  /** Wikilink to the note holding it, when there is one. */
  note: string;
}

export interface ProjectNote extends WorkflowNote {
  owner: string;
  /** Who has to keep wanting this for it to survive (§5.15). */
  sponsor: string;
  started: number | null;
  studies: string[];
  /** Requests done inside the project, for the effort roll-up. */
  requests: string[];
  milestones: Milestone[];
  deliverables: Deliverable[];
  /** Hours quoted up front, so the portfolio can show estimate against actual. */
  effortEstimateHours: number | null;
}

export interface ParsedProject {
  project: ProjectNote;
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

/** Read a list of wikilinks or plain names. A bare string counts as a list of one. */
function links(value: unknown): string[] {
  if (typeof value === "string") {
    const one = value.trim();
    return one === "" ? [] : [one];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry)).filter((entry) => entry !== "");
}

function parseMilestones(raw: unknown, problems: string[]): Milestone[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("`milestones` is not a list, so no milestones were read.");
    return [];
  }

  const milestones: Milestone[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`milestones[${index}] is not a mapping and was ignored.`);
      return;
    }
    const id = str(entry["id"]);
    if (id === "") {
      problems.push(`milestones[${index}] has no \`id\` and was ignored; \`blocked_by\` needs one.`);
      return;
    }
    if (seen.has(id)) {
      // Two milestones answering to one id would make `blocked_by` ambiguous,
      // and an ambiguous predecessor edge is worse than a missing one.
      problems.push(`milestones[${index}] repeats the id "${id}" and was ignored.`);
      return;
    }
    seen.add(id);

    milestones.push({
      id,
      title: str(entry["title"]),
      due: parseTimestamp(entry["due"]),
      done: parseTimestamp(entry["done"]),
      blockedBy: links(entry["blocked_by"]),
      event: str(entry["event"]),
    });
  });

  // An edge to a milestone that does not exist is dropped and named. Keeping it
  // would make the milestone permanently unready for a reason no one can see.
  for (const milestone of milestones) {
    const missing = milestone.blockedBy.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      problems.push(
        `${milestone.id} is blocked by ${missing.join(", ")}, which ${
          missing.length === 1 ? "is not a milestone" : "are not milestones"
        } of this project. ${missing.length === 1 ? "That edge was" : "Those edges were"} ignored.`,
      );
      milestone.blockedBy = milestone.blockedBy.filter((id) => seen.has(id));
    }
  }

  // §5.15: a cycle is refused at parse time, with the cycle named. Refused here
  // means the edges are dropped rather than the note — nothing in this codebase
  // throws on note content — but the effect is the same: no downstream reader
  // can walk a loop, because there is no loop left to walk.
  const cycle = cycleThrough(milestones);
  if (cycle !== null) {
    problems.push(
      `\`blocked_by\` forms a cycle: ${cycle.join(" → ")}. ` +
        `Those edges were dropped, because a milestone that waits on itself can never start.`,
    );
    const inCycle = new Set(cycle);
    for (const milestone of milestones) {
      if (inCycle.has(milestone.id)) milestone.blockedBy = [];
    }
  }

  return milestones;
}

function parseDeliverables(raw: unknown, problems: string[]): Deliverable[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("`deliverables` is not a list, so none were read.");
    return [];
  }
  const deliverables: Deliverable[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`deliverables[${index}] is not a mapping and was ignored.`);
      return;
    }
    const title = str(entry["title"]);
    if (title === "") {
      problems.push(`deliverables[${index}] has no \`title\` and was ignored.`);
      return;
    }
    deliverables.push({ title, kind: str(entry["kind"]), note: str(entry["note"]) });
  });
  return deliverables;
}

/** Read a project note's frontmatter. Never throws. */
export function parseProject(frontmatter: unknown): ParsedProject {
  const problems: string[] = [];
  const raw: Record<string, unknown> = isRecord(frontmatter) ? frontmatter : {};
  if (!isRecord(frontmatter)) problems.push("The note has no frontmatter.");

  const history = parseHistory(raw["history"], problems);
  const stage = str(raw["stage"]);
  if (stage === "") problems.push("The note has no `stage`.");

  const uid = str(raw["uid"]);
  if (uid === "") {
    problems.push("The note has no `uid`. Machine references and the audit trail need one.");
  }

  const workflowVersion = num(raw["workflow_version"]);
  if (raw["workflow_version"] !== undefined && workflowVersion === null) {
    problems.push("`workflow_version` is not a number.");
  }

  const blockedOn = str(raw["blocked_on"]);

  const project: ProjectNote = {
    uid,
    id: str(raw["id"]),
    title: str(raw["title"]),

    workflow: str(raw["workflow"]),
    workflowVersion,

    stage,
    blockedOn: blockedOn === "" ? null : blockedOn,
    blockedSince: parseTimestamp(raw["blocked_since"]),

    hat: str(raw["hat"]),

    // A project's clock starts at `started`; there is no `received`, because
    // nobody handed it in. The engine reads `received`, so this is where the
    // two shapes meet.
    received: parseTimestamp(raw["started"]),
    due: parseTimestamp(raw["due"]),
    slaDays: num(raw["sla_days"]),

    evidence: parseEvidence(raw["evidence"], problems),
    history,

    raw,

    owner: str(raw["owner"]),
    sponsor: str(raw["sponsor"]),
    started: parseTimestamp(raw["started"]),
    studies: links(raw["studies"]),
    requests: links(raw["requests"]),
    milestones: parseMilestones(raw["milestones"], problems),
    deliverables: parseDeliverables(raw["deliverables"], problems),
    effortEstimateHours: num(raw["effort_estimate_hours"]),
  };

  const last = history[history.length - 1];
  if (last && stage !== "" && last.to !== stage) {
    problems.push(
      `\`stage: ${stage}\` does not match the last history entry (\`${last.to}\`). ` +
        `Dwell time is measured from the history, so it may not be what you expect.`,
    );
  }

  return { project, problems };
}
