/**
 * The meeting agenda generator (CLAUDE.md §7 B1).
 *
 * Pick a person; get everything they are holding up, with how long it has been
 * waiting. Requests awaiting their approval, manuscripts awaiting their review,
 * obligations they own, and outreach they have not answered — one list, in one
 * order, ready to walk down in a ten-minute corridor conversation.
 *
 * The value is entirely in the *joining*. Each of those four lives in a
 * different folder under a differently-named field, so today the answer is
 * assembled by remembering. One thing forgotten is one more fortnight of dwell
 * time on a request nobody mentioned.
 *
 * **What is deliberately not here:** any judgement about whether the person is
 * at fault. The list says what is waiting and for how long; it does not say
 * anyone is slow. A tool that generates accusations gets used once.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { PublicationNote } from "../publication/publication";
import { inFlight } from "../publication/publication";
import { rowState, type RequestView } from "../request/holdup";
import { DAY_MS, parseTimestamp, toVaultDate } from "../time/dates";
import { parseParty, partiesIn, type Party } from "./party";
import { agedOutreach, type Thread } from "./thread";

export type AgendaKind = "request" | "publication" | "obligation" | "outreach" | "other";

export interface AgendaItem {
  kind: AgendaKind;
  /** The human label, used as the wikilink target and as the row's name. */
  link: string;
  title: string;
  /** What is wanted from them, in words. */
  ask: string;
  /** Where it stands: stage, journal, date. One short line. */
  context: string;
  /** How long it has been waiting on them. Null when the note has no usable date. */
  waitedMs: number | null;
  /** Breached, lapsed, or long unanswered — the ones to raise first. */
  urgent: boolean;
}

export interface Agenda {
  party: Party;
  items: AgendaItem[];
  longestWaitMs: number | null;
  urgentCount: number;
}

/** A note the agenda scans generically, as the index holds it. */
export interface AgendaNote {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Fields that mean "this note is on that person".
 *
 * Listed rather than inferred, because guessing is how an agenda quietly grows
 * items the person has nothing to do with. `blocked_on` is §5.1's holdup field;
 * `owner` is §5.7's on an obligation; the rest are conventional and harmless to
 * check. B3 and B6 add note types, not new field names.
 */
const RESPONSIBILITY_FIELDS = ["blocked_on", "owner", "assignee", "approver", "reviewer"] as const;

/** Values of `stage`, `state` or `status` that mean nothing more is wanted. */
const SETTLED = new Set([
  "done",
  "complete",
  "completed",
  "closed",
  "delivered",
  "withdrawn",
  "cancelled",
  "canceled",
  "abandoned",
]);

/** Types the agenda handles specifically; the generic scan must not double-count them. */
const HANDLED_ELSEWHERE = new Set(["scdb-request", "correspondence", "publication"]);

function isSettled(frontmatter: Record<string, unknown>): boolean {
  for (const key of ["stage", "state", "status"]) {
    const value = frontmatter[key];
    if (typeof value === "string" && SETTLED.has(value.trim().toLowerCase())) return true;
  }
  return false;
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

function label(frontmatter: Record<string, unknown>, path: string): string {
  const id = frontmatter["id"];
  return typeof id === "string" && id.trim() !== "" ? id.trim() : basename(path);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "9 days", for a context line. Whole days, because that is how people speak. */
function days(ms: number | null): string {
  if (ms === null) return "no date recorded";
  const whole = Math.round(ms / DAY_MS);
  return whole === 1 ? "1 day" : `${whole} days`;
}

export interface AgendaInput {
  /** The person, exactly as picked — a wikilink or a bare name. */
  party: string;
  now: number;
  views?: readonly RequestView[];
  threads?: readonly Thread[];
  publications?: readonly PublicationNote[];
  /** Everything else the index holds, for the generic scan. */
  notes?: readonly AgendaNote[];
  chaseDays?: number;
}

/**
 * Everything one person is holding up, most pressing first.
 *
 * Ordered urgent-first and then longest-wait-first, which is the order the
 * conversation should take: the thing that has already breached gets said while
 * you still have their attention.
 */
export function buildAgenda(input: AgendaInput): Agenda {
  const party = parseParty(input.party);
  const items: AgendaItem[] = [];

  if (party.key !== "") {
    items.push(...requestItems(party, input.views ?? []));
    items.push(...outreachItems(party, input.threads ?? [], input.now, input.chaseDays));
    items.push(...publicationItems(party, input.publications ?? []));
    items.push(...noteItems(party, input.notes ?? [], input.now));
  }

  items.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    return (b.waitedMs ?? -1) - (a.waitedMs ?? -1);
  });

  return {
    party,
    items,
    longestWaitMs: items.reduce<number | null>(
      (worst, item) => (item.waitedMs === null ? worst : Math.max(worst ?? 0, item.waitedMs)),
      null,
    ),
    urgentCount: items.filter((item) => item.urgent).length,
  };
}

/* -------------------------------------------------------------- requests -- */

function requestItems(party: Party, views: readonly RequestView[]): AgendaItem[] {
  const items: AgendaItem[] = [];

  for (const view of views) {
    if (view.metrics.completed) continue;
    const blockedOn = view.metrics.blockedOn;
    if (blockedOn === null || parseParty(blockedOn).key !== party.key) continue;

    const state = rowState(view);
    items.push({
      kind: "request",
      link: view.request.id || view.request.uid,
      title: view.request.title,
      ask: `Waiting on them at the ${view.request.stage} stage.`,
      context: `Blocked ${days(view.metrics.blockedForMs)}; ${days(
        view.metrics.totalAgeMs,
      )} old in total.`,
      waitedMs: view.metrics.blockedForMs,
      urgent: state === "breached",
    });
  }

  return items;
}

/* -------------------------------------------------------------- outreach -- */

function outreachItems(
  party: Party,
  threads: readonly Thread[],
  now: number,
  chaseDays: number | undefined,
): AgendaItem[] {
  const aged = agedOutreach(threads, {
    now,
    ...(chaseDays === undefined ? {} : { chaseDays }),
  });

  return aged
    .filter((entry) => entry.thread.with.some((person) => person.key === party.key))
    .map((entry) => ({
      kind: "outreach" as const,
      link: entry.thread.id,
      title: entry.thread.subject,
      // "Composed" rather than "sent" — §5.11 rule 6 holds here too, and this
      // line is read aloud to the person it is about.
      ask: "No reply recorded since we last wrote.",
      context: `${entry.thread.channel}, composed ${days(entry.waitingMs)} ago.`,
      waitedMs: entry.waitingMs,
      urgent: entry.overdue,
    }));
}

/* ---------------------------------------------------------- publications -- */

/**
 * Manuscripts waiting on this person.
 *
 * Only `internal-review`, and only when they are an author. That is the narrow
 * reading of §7 B1's "manuscripts awaiting their review", and it is the right
 * one: a paper under review at a journal is waiting on the journal, and putting
 * it on a co-author's agenda would be asking them for something they cannot
 * give.
 */
function publicationItems(party: Party, publications: readonly PublicationNote[]): AgendaItem[] {
  return publications
    .filter(
      (publication) =>
        inFlight(publication) &&
        publication.stage === "internal-review" &&
        publication.authors.some((author) => author.key === party.key),
    )
    .map((publication) => ({
      kind: "publication" as const,
      link: publication.id === "" ? basename(publication.path) : publication.id,
      title: publication.title,
      ask: "Awaiting their comments on the draft.",
      context: publication.journal === "" ? "Internal review." : `For ${publication.journal}.`,
      waitedMs: null,
      urgent: false,
    }));
}

/* ------------------------------------------------------- everything else -- */

function noteItems(
  party: Party,
  notes: readonly AgendaNote[],
  now: number,
): AgendaItem[] {
  const items: AgendaItem[] = [];

  for (const note of notes) {
    if (HANDLED_ELSEWHERE.has(note.type)) continue;
    if (isSettled(note.frontmatter)) continue;

    const field = RESPONSIBILITY_FIELDS.find((key) =>
      partiesIn(note.frontmatter[key]).some((person) => person.key === party.key),
    );
    if (field === undefined) continue;

    const dueMs = parseTimestamp(note.frontmatter["due"]);
    const overdue = dueMs !== null && dueMs < now;

    // §5.7 requires an obligation to say what breaks if it lapses, and a
    // reminder that does not say gets ignored. Carry it through verbatim.
    const consequence = text(note.frontmatter["consequence"]);

    items.push({
      kind: note.type === "obligation" ? "obligation" : "other",
      link: label(note.frontmatter, note.path),
      title: text(note.frontmatter["title"]) || basename(note.path),
      ask: `They are the ${field.replace(/_/g, " ")} on this.`,
      context:
        (dueMs === null
          ? "No due date."
          : `Due ${toVaultDate(dueMs)}${overdue ? " — passed" : ""}.`) +
        (consequence === "" ? "" : ` ${consequence}`),
      waitedMs: overdue && dueMs !== null ? now - dueMs : null,
      urgent: overdue,
    });
  }

  return items;
}

/** "3 requests, 1 manuscript" — the one-line summary above an agenda. */
export function summariseAgenda(agenda: Agenda): string {
  if (agenda.items.length === 0) return "Nothing open with this person.";

  const nouns: Record<AgendaKind, [string, string]> = {
    request: ["request", "requests"],
    publication: ["manuscript", "manuscripts"],
    obligation: ["obligation", "obligations"],
    outreach: ["unanswered message", "unanswered messages"],
    other: ["item", "items"],
  };

  const counts = new Map<AgendaKind, number>();
  for (const item of agenda.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);

  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${nouns[kind][n === 1 ? 0 : 1]}`)
    .join(", ");
}
