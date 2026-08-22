/**
 * The daily briefing (CLAUDE.md §7 B1).
 *
 * Generated on the first vault open of each day: what is due, what is
 * breaching, what is stuck and with whom, what decisions are awaited, and which
 * obligations are approaching. One note, links everywhere.
 *
 * It is written as **markdown, not a view**, and that is the point. A view
 * disappears when you close it; a note is a dated record you can scroll back
 * through in six months and see what the queue looked like on the day you made
 * a decision. It also survives the plugin being uninstalled, which rule 11
 * requires of everything written here.
 *
 * **Sections are actions, not buckets.** One request can appear under two
 * headings when there are two different things to do about it — an overdue
 * request that is also sitting with an approver belongs both under "against
 * target" (it needs escalating) and under "stuck, and with whom" (it needs one
 * email that also covers four others). Collapsing those would save a line and
 * cost the second action. What is *not* allowed is a heading that restates
 * another with no new decision attached, which is why there is no "all open
 * requests" section: that is the queue board's job.
 *
 * **It never overwrites a briefing that already exists.** The note is a record
 * of a morning, and it may have been annotated by lunchtime.
 *
 * Pure module: no Obsidian, no Node.
 */

import { groupByBlockingParty, rowState, type RequestView } from "../request/holdup";
import type { Overview } from "../overview/overview";
import { DAY_MS, formatDuration, toVaultDate } from "../time/dates";
import { groupOutreachByParty, type AgedThread } from "../comms/thread";

export const BRIEFING_TYPE = "briefing";

export interface BriefingInput {
  now: number;
  actor: string;
  /** The hat being worn, recorded so a later reader knows what was filtered. */
  mode: string;
  overview: Overview;
  outreach: readonly AgedThread[];
  views: readonly RequestView[];
}

export interface Briefing {
  /** `YYYY-MM-DD`, and the note's filename stem. */
  date: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** True when every section was empty. The caller may choose not to write. */
  quiet: boolean;
}

/** `[[REQ-2026-014]] — title`, the shape every line in the briefing takes. */
function link(target: string, title: string): string {
  // A path may arrive where an id was missing; a `[[note.md]]` link resolves but reads
  // like a bug, so the extension comes off.
  const to = target.trim().replace(/\.md$/, "");
  const clean = title.trim();
  return clean === "" ? `[[${to}]]` : `[[${to}]] — ${clean}`;
}

/** The one formatter (§6) — the same words the boards and the export use. */
function days(ms: number | null): string {
  return ms === null ? "no date" : formatDuration(ms);
}

interface Section {
  heading: string;
  /** What the section is, shown when it is empty (§6, empty states matter). */
  whenEmpty: string;
  lines: string[];
}

function renderSection(section: Section): string[] {
  return [
    `## ${section.heading}`,
    "",
    ...(section.lines.length === 0 ? [`*${section.whenEmpty}*`] : section.lines),
    "",
  ];
}

/* --------------------------------------------------------------- sections -- */

/** Requests and dated notes falling due today. The narrowest, most useful list. */
function dueToday(input: BriefingInput): string[] {
  const today = toVaultDate(input.now);
  const lines: string[] = [];

  for (const view of input.views) {
    if (view.metrics.completed) continue;
    if (view.request.due === null || toVaultDate(view.request.due) !== today) continue;
    lines.push(`- ${link(view.request.id, view.request.title)} — due today.`);
  }

  for (const deadline of input.overview.deadlines) {
    if (deadline.inDays !== 0) continue;
    lines.push(
      `- ${link(deadline.id, deadline.title)} — ${deadline.what} today.` +
        (deadline.consequence === "" ? "" : ` ${deadline.consequence}`),
    );
  }

  return lines;
}

/**
 * What has already broken a target, or is about to.
 *
 * Taken from the attention list rather than recomputed, so the briefing and the
 * cockpit can never disagree about what is overdue.
 */
function slaLines(input: BriefingInput): string[] {
  return input.overview.attention
    .filter((item) => item.reasons.some((r) => r.reason === "overdue" || r.reason === "at-risk"))
    .map((item) => {
      const state = rowState(item.view) === "breached" ? "Breached" : "At risk";
      return (
        `- **${state}** · ${link(item.view.request.id, item.view.request.title)} — ` +
        `${days(item.view.metrics.currentDwellMs)} in ${item.view.request.stage}, ` +
        `${days(item.view.metrics.totalAgeMs)} old.`
      );
    });
}

/** Grouped by person, because one chase-up email covers five requests. */
function stuckWithLines(input: BriefingInput): string[] {
  const lines: string[] = [];

  for (const group of groupByBlockingParty(input.views)) {
    lines.push(
      `- **${group.party}** — ${group.views.length === 1 ? "1 request" : `${group.views.length} requests`}` +
        `, longest ${days(group.longestBlockedMs)}:`,
    );
    for (const view of group.views) {
      lines.push(`    - ${link(view.request.id, view.request.title)} (${view.request.stage})`);
    }
  }

  return lines;
}

/**
 * Outreach with no reply recorded (§5.10 Tier 0).
 *
 * "Recorded" is doing real work in that phrasing: the plugin knows what it
 * composed and nothing else, so a reply that arrived and was never logged looks
 * identical to no reply. Saying "no reply recorded" rather than "no reply"
 * keeps the briefing honest about what it actually knows.
 */
function outreachLines(input: BriefingInput): string[] {
  const lines: string[] = [];

  for (const group of groupOutreachByParty(input.outreach)) {
    for (const entry of group.threads) {
      lines.push(
        `- **${group.party.name}** — ${link(entry.thread.id, entry.thread.subject)}, ` +
          `composed ${days(entry.waitingMs)} ago, no reply recorded.`,
      );
    }
  }

  return lines;
}

/** Manuscripts with a decision expected, soonest first. */
function decisionLines(input: BriefingInput): string[] {
  return input.overview.publications
    .filter((publication) => publication.decisionDue !== null)
    .map((publication) => {
      const due = publication.decisionDue!;
      const inDays = Math.round((due - input.now) / DAY_MS);
      const when = inDays < 0 ? `${Math.abs(inDays)} days overdue` : `in ${inDays} days`;
      return (
        `- ${link(publication.id, publication.title)} — ${publication.stage}` +
        `${publication.journal === "" ? "" : ` at ${publication.journal}`}, decision ${when}.`
      );
    });
}

/** Obligations coming up, plus the ones §5.7 says must never be silently missed. */
function obligationLines(input: BriefingInput): string[] {
  const lines = input.overview.deadlines
    .filter((deadline) => deadline.inDays > 0 && deadline.type !== "scdb-request")
    .map(
      (deadline) =>
        `- ${link(deadline.id, deadline.title)} — ${deadline.what} in ${deadline.inDays} days.` +
        (deadline.consequence === "" ? "" : ` ${deadline.consequence}`),
    );

  for (const note of input.overview.unscheduled) {
    const id = note.frontmatter["id"];
    const target = typeof id === "string" && id.trim() !== "" ? id.trim() : note.path;
    const title = note.frontmatter["title"];
    lines.push(
      `- **Unscheduled** · ${link(target, typeof title === "string" ? title : "")} — ` +
        `has a recurrence rule but no next date, so nothing is watching it.`,
    );
  }

  return lines;
}

/** Requests the plugin could not fully read, or that a workflow change stranded. */
function problemLines(input: BriefingInput): string[] {
  return input.overview.attention
    .filter((item) => item.reasons.some((r) => r.reason === "problem" || r.reason === "stranded"))
    .map((item) => {
      const worst = item.reasons.find((r) => r.reason === "problem" || r.reason === "stranded")!;
      return `- ${link(item.view.request.id, item.view.request.title)} — ${worst.detail}`;
    });
}

/* ------------------------------------------------------------------ build -- */

export function buildBriefing(input: BriefingInput): Briefing {
  const date = toVaultDate(input.now);

  const sections: Section[] = [
    {
      heading: "Needs reading first",
      whenEmpty: "Nothing unreadable or stranded. Every request is on the current workflow.",
      lines: problemLines(input),
    },
    { heading: "Due today", whenEmpty: "Nothing falls due today.", lines: dueToday(input) },
    {
      heading: "Against target",
      whenEmpty: "No request is past or near its SLA target.",
      lines: slaLines(input),
    },
    {
      heading: "Stuck, and with whom",
      whenEmpty: "No request is waiting on anybody.",
      lines: stuckWithLines(input),
    },
    {
      heading: "Awaiting a reply",
      whenEmpty: "No outreach is outstanding.",
      lines: outreachLines(input),
    },
    {
      heading: "Decisions awaited",
      whenEmpty: "No manuscript has a decision date recorded.",
      lines: decisionLines(input),
    },
    {
      heading: "Coming up",
      whenEmpty: "No obligation falls due in the window.",
      lines: obligationLines(input),
    },
  ];

  const quiet = sections.every((section) => section.lines.length === 0);

  const body = [
    `# Briefing — ${date}`,
    "",
    quiet
      ? "*Nothing is overdue, stuck or falling due. Enjoy it.*"
      : "*Generated from the vault as it stood this morning. The institutional eData " +
        "system remains the record of truth (§5.1).*",
    "",
    ...sections.flatMap(renderSection),
  ].join("\n");

  return {
    date,
    frontmatter: {
      type: BRIEFING_TYPE,
      // Not a uid: a briefing is named by its date and there is one per day.
      date,
      mode: input.mode,
      generated_by: input.actor,
    },
    body,
    quiet,
  };
}

/** True when today's briefing has not been written yet. */
export function briefingDue(lastBriefingDate: string, now: number): boolean {
  return lastBriefingDate !== toVaultDate(now);
}
