/**
 * One person, everything of theirs, on one row (CLAUDE.md §7 B1).
 *
 * The holdup board answers "who is the holdup" out of two sources that mean
 * the same thing: requests whose `blocked_on` names somebody (§5.1), and
 * outreach to them with no reply recorded (§5.10). Rendering those as two lists
 * put **the same person under two headings, one above the other** — which is
 * the exact failure that putting outreach on this board was meant to prevent.
 * A reader scanning for a name finds the first heading, acts on it, and never
 * sees the second.
 *
 * So they merge here, keyed the way `party.ts` keys people, before anything is
 * drawn. This is in `domain/` rather than the view because "is this the same
 * person" and "who is worst" are questions worth testing, not layout.
 *
 * Pure module: no Obsidian, no Node.
 */

import { rowState, type PartyGroup, type RequestView } from "../request/holdup";
import { parseParty, type Party } from "./party";
import type { AgedThread, OutreachParty } from "./thread";

export interface HoldupPerson {
  party: Party;
  /** Requests waiting on them, already ordered by urgency. */
  views: RequestView[];
  /** Unanswered outreach, already ordered longest-wait first. */
  threads: AgedThread[];
  /** How many of their requests have breached — the first sort key. */
  breachedCount: number;
  /** Longest wait across everything of theirs. */
  longestMs: number | null;
}

function longest(...values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * Merge the two sources into one row per person, worst first.
 *
 * Ordered by breached requests, then by the longest wait of any kind. Somebody
 * with nothing overdue but a message unanswered for three months still rises;
 * somebody sitting on a breached request outranks them, because a breach is a
 * commitment already missed rather than a courtesy overdue.
 */
export function mergeHoldup(
  parties: readonly PartyGroup[],
  outreach: readonly OutreachParty[],
): HoldupPerson[] {
  const byKey = new Map<string, HoldupPerson>();

  for (const group of parties) {
    const party = parseParty(group.party);
    byKey.set(party.key, {
      party,
      views: group.views,
      threads: [],
      breachedCount: group.breachedCount,
      longestMs: group.longestBlockedMs,
    });
  }

  for (const group of outreach) {
    const existing = byKey.get(group.party.key);
    if (existing === undefined) {
      byKey.set(group.party.key, {
        party: group.party,
        views: [],
        threads: group.threads,
        breachedCount: 0,
        longestMs: group.longestWaitMs,
      });
      continue;
    }
    existing.threads = group.threads;
    existing.longestMs = longest(existing.longestMs, group.longestWaitMs);
  }

  return [...byKey.values()].sort((a, b) => {
    if (b.breachedCount !== a.breachedCount) return b.breachedCount - a.breachedCount;
    return (b.longestMs ?? -1) - (a.longestMs ?? -1);
  });
}

/** "2 requests · 1 unanswered message", omitting whichever is zero. */
export function describeHoldup(person: HoldupPerson): string {
  const parts: string[] = [];
  if (person.views.length > 0) {
    parts.push(`${person.views.length} request${person.views.length === 1 ? "" : "s"}`);
  }
  if (person.threads.length > 0) {
    parts.push(
      `${person.threads.length} unanswered message${person.threads.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" · ");
}

/** How many of a person's requests have already breached. Recomputed, not trusted. */
export function breachedIn(views: readonly RequestView[]): number {
  return views.filter((view) => rowState(view) === "breached").length;
}
