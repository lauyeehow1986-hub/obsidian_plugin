/**
 * The cockpit overview (CLAUDE.md §7 A3).
 *
 * One pane answering "what should I look at first?" out of three lists that
 * would otherwise live on three different boards: what needs attention, what
 * falls due soon, and which manuscripts are in flight.
 *
 * The ordering rules are here rather than in the view because they *are* the
 * feature — a "needs attention" list in arbitrary order is a second inbox.
 *
 * Pure module: no Obsidian, no Node.
 */

import { publicationsInFlight, type PublicationNote } from "../publication/publication";
import { rowState, type RequestView } from "../request/holdup";
import { DAY_MS, parseTimestamp } from "../time/dates";

/* ----------------------------------------------------------- attention -- */

/** Ordered worst-first; the number is the sort key and never shown. */
const SEVERITY = {
  problem: 0,
  stranded: 1,
  overdue: 2,
  blocked: 3,
  "at-risk": 4,
} as const;

export type AttentionReason = keyof typeof SEVERITY;

export interface AttentionItem {
  view: RequestView;
  /** Every reason that applies, worst first. All of them, not just the worst. */
  reasons: { reason: AttentionReason; detail: string }[];
}

export interface AttentionOptions {
  now: number;
  /** True when the request is quarantined by a workflow change (§5.2). */
  stranded: (view: RequestView) => boolean;
  /** True when every onward move is refused by a gate. */
  governanceBlocked: (view: RequestView) => boolean;
  /** How long a holdup has to have lasted before it counts on its own. */
  blockedDays?: number;
}

/**
 * Requests that want looking at, worst first.
 *
 * A request can qualify on several counts and **all of them are listed**. The
 * tempting simplification — show only the worst reason — hides the case this
 * board exists for: the request that is overdue *and* stranded *and* waiting on
 * somebody is not three-times-as-bad-as-overdue, it is a different problem.
 *
 * A note the metrics could not fully trust — unreadable dates, a stage the spec
 * does not list — ranks above everything else, because every other judgement on
 * this board is computed from the fields it could not read.
 */
export function needsAttention(
  views: readonly RequestView[],
  options: AttentionOptions,
): AttentionItem[] {
  const blockedMs = (options.blockedDays ?? 7) * DAY_MS;
  const items: AttentionItem[] = [];

  for (const view of views) {
    if (view.metrics.completed) continue;
    const reasons: AttentionItem["reasons"] = [];

    if (view.metrics.problems.length > 0) {
      reasons.push({ reason: "problem", detail: view.metrics.problems.join(" ") });
    }
    if (options.stranded(view)) {
      reasons.push({
        reason: "stranded",
        detail: "On an older workflow version; it cannot change stage until it is migrated.",
      });
    }
    if (options.governanceBlocked(view)) {
      reasons.push({
        reason: "blocked",
        detail: "Every onward stage is refused by a governance gate.",
      });
    }

    const state = rowState(view);
    if (state === "breached") {
      reasons.push({ reason: "overdue", detail: "Past its SLA target or its due date." });
    } else if (state === "at-risk") {
      reasons.push({ reason: "at-risk", detail: "Close to its SLA target or its due date." });
    }

    const blockedFor = view.metrics.blockedForMs;
    if (view.metrics.blockedOn !== null && blockedFor !== null && blockedFor >= blockedMs) {
      reasons.push({
        reason: "blocked",
        detail: `Waiting on ${view.metrics.blockedOn} for ${Math.round(blockedFor / DAY_MS)} days.`,
      });
    }

    if (reasons.length === 0) continue;
    reasons.sort((a, b) => SEVERITY[a.reason] - SEVERITY[b.reason]);
    items.push({ view, reasons });
  }

  return items.sort((a, b) => {
    const worst = SEVERITY[a.reasons[0]!.reason] - SEVERITY[b.reasons[0]!.reason];
    if (worst !== 0) return worst;
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return (b.view.metrics.totalAgeMs ?? 0) - (a.view.metrics.totalAgeMs ?? 0);
  });
}

/* ----------------------------------------------------------- deadlines -- */

/** A note as the index holds it, with no Obsidian types attached. */
export interface DatedNote {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
}

export interface Deadline {
  path: string;
  type: string;
  /** The human label — `id` where there is one, else the file's basename. */
  id: string;
  title: string;
  /** Which field this came from, in words: "due", "decision due". */
  what: string;
  at: number;
  /** Negative when it has already passed. */
  inDays: number;
  overdue: boolean;
  /** §5.7 requires obligations to say what breaks. Empty for everything else. */
  consequence: string;
}

/** Where a date lives, per note type. First match wins. */
const DATE_FIELDS: Record<string, { field: string; what: string }[]> = {
  publication: [{ field: "decision_due", what: "decision due" }],
};
const DEFAULT_FIELDS = [{ field: "due", what: "due" }];

function basename(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/, "");
}

/**
 * Dated notes falling due inside the window, soonest first.
 *
 * Deliberately generic: any note carrying a readable `due` counts, whatever its
 * type. That covers event and obligation notes today without pre-empting B3's
 * recurrence engine — when that lands it materialises the next occurrence as an
 * ordinary date on the note, and this list picks it up with no change here.
 *
 * What it does **not** do is compute a next occurrence from a `recurrence:`
 * rule. An obligation with a rule and no materialised date is reported as
 * unscheduled rather than quietly omitted, because §5.7's whole point is that a
 * lapsed obligation is the thing that must never be missed.
 */
export function deadlines(
  notes: readonly DatedNote[],
  options: { now: number; withinDays?: number },
): { due: Deadline[]; unscheduled: DatedNote[] } {
  const within = (options.withinDays ?? 60) * DAY_MS;
  const due: Deadline[] = [];
  const unscheduled: DatedNote[] = [];

  for (const note of notes) {
    const fields = DATE_FIELDS[note.type] ?? DEFAULT_FIELDS;
    const found = fields
      .map((entry) => ({ ...entry, at: parseTimestamp(note.frontmatter[entry.field]) }))
      .find((entry) => entry.at !== null);

    if (found === undefined || found.at === null) {
      if (note.frontmatter["recurrence"] !== undefined) unscheduled.push(note);
      continue;
    }
    if (found.at - options.now > within) continue;

    const id = typeof note.frontmatter["id"] === "string" ? note.frontmatter["id"].trim() : "";
    const title =
      typeof note.frontmatter["title"] === "string" ? note.frontmatter["title"].trim() : "";
    const consequence =
      typeof note.frontmatter["consequence"] === "string"
        ? note.frontmatter["consequence"].trim()
        : "";

    due.push({
      path: note.path,
      type: note.type,
      id: id === "" ? basename(note.path) : id,
      title,
      what: found.what,
      at: found.at,
      inDays: Math.round((found.at - options.now) / DAY_MS),
      overdue: found.at < options.now,
      consequence,
    });
  }

  return { due: due.sort((a, b) => a.at - b.at), unscheduled };
}

/* -------------------------------------------------------------- the lot -- */

export interface Overview {
  attention: AttentionItem[];
  deadlines: Deadline[];
  /** Obligations carrying a recurrence rule but no materialised date (B3). */
  unscheduled: DatedNote[];
  publications: PublicationNote[];
}

export function buildOverview(
  views: readonly RequestView[],
  notes: readonly DatedNote[],
  publications: readonly PublicationNote[],
  options: AttentionOptions & { withinDays?: number },
): Overview {
  const dated = deadlines(notes, {
    now: options.now,
    ...(options.withinDays === undefined ? {} : { withinDays: options.withinDays }),
  });
  return {
    attention: needsAttention(views, options),
    deadlines: dated.due,
    unscheduled: dated.unscheduled,
    publications: publicationsInFlight(publications),
  };
}
