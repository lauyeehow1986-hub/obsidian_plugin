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

/** One agenda item, tagged with whose it is. The internal currency of this module. */
interface Entry {
  party: Party;
  item: AgendaItem;
}

/**
 * Every open item in the vault, tagged with the person it is waiting on.
 *
 * One pass, whoever is asking. The person picker needs a count for everybody,
 * and building a whole agenda per candidate would walk the note list once per
 * name — fine at ten people and a thousand notes, not fine at the sizes A2
 * budgets for.
 */
function allEntries(input: Omit<AgendaInput, "party">): Entry[] {
  return [
    ...requestEntries(input.views ?? []),
    ...outreachEntries(input.threads ?? [], input.now, input.chaseDays),
    ...publicationEntries(input.publications ?? []),
    ...noteEntries(input.notes ?? [], input.now),
  ];
}

/**
 * Urgent first, then longest wait — the order the conversation should take:
 * the thing that has already breached gets said while you still have their
 * attention.
 */
function byPressure(a: AgendaItem, b: AgendaItem): number {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  return (b.waitedMs ?? -1) - (a.waitedMs ?? -1);
}

function assemble(party: Party, items: AgendaItem[]): Agenda {
  const sorted = [...items].sort(byPressure);
  return {
    party,
    items: sorted,
    longestWaitMs: sorted.reduce<number | null>(
      (worst, item) => (item.waitedMs === null ? worst : Math.max(worst ?? 0, item.waitedMs)),
      null,
    ),
    urgentCount: sorted.filter((item) => item.urgent).length,
  };
}

/** Everything one person is holding up, most pressing first. */
export function buildAgenda(input: AgendaInput): Agenda {
  const party = parseParty(input.party);
  if (party.key === "") return assemble(party, []);

  return assemble(
    party,
    allEntries(input)
      .filter((entry) => entry.party.key === party.key)
      .map((entry) => entry.item),
  );
}

export interface AgendaCandidate {
  party: Party;
  count: number;
  urgentCount: number;
  /** "4 requests, 1 unanswered message" — enough to pick from a list. */
  detail: string;
}

/**
 * Everyone with something open, busiest first.
 *
 * The list for the person picker. Ordered by what is waiting rather than
 * alphabetically, because the person holding up nine things is the one you are
 * looking for.
 */
export function agendaCandidates(input: Omit<AgendaInput, "party">): AgendaCandidate[] {
  const byKey = new Map<string, { party: Party; items: AgendaItem[] }>();

  for (const entry of allEntries(input)) {
    const group = byKey.get(entry.party.key) ?? { party: entry.party, items: [] };
    group.items.push(entry.item);
    byKey.set(entry.party.key, group);
  }

  return [...byKey.values()]
    .map((group) => {
      const agenda = assemble(group.party, group.items);
      return {
        party: group.party,
        count: agenda.items.length,
        urgentCount: agenda.urgentCount,
        detail: summariseAgenda(agenda),
      };
    })
    .sort(
      (a, b) =>
        b.urgentCount - a.urgentCount ||
        b.count - a.count ||
        a.party.name.localeCompare(b.party.name),
    );
}

/* -------------------------------------------------------------- requests -- */

function requestEntries(views: readonly RequestView[]): Entry[] {
  const entries: Entry[] = [];

  for (const view of views) {
    if (view.metrics.completed) continue;
    const blockedOn = view.metrics.blockedOn;
    if (blockedOn === null || blockedOn === "") continue;

    entries.push({
      party: parseParty(blockedOn),
      item: {
        kind: "request",
        link: view.request.id || view.request.uid,
        title: view.request.title,
        ask: `Waiting on them at the ${view.request.stage} stage.`,
        context: `Blocked ${days(view.metrics.blockedForMs)}; ${days(
          view.metrics.totalAgeMs,
        )} old in total.`,
        waitedMs: view.metrics.blockedForMs,
        urgent: rowState(view) === "breached",
      },
    });
  }

  return entries;
}

/* -------------------------------------------------------------- outreach -- */

function outreachEntries(
  threads: readonly Thread[],
  now: number,
  chaseDays: number | undefined,
): Entry[] {
  const aged = agedOutreach(threads, {
    now,
    ...(chaseDays === undefined ? {} : { chaseDays }),
  });

  return aged.flatMap((entry) =>
    entry.thread.with.map((party) => ({
      party,
      item: {
        kind: "outreach" as const,
        link: entry.thread.id,
        title: entry.thread.subject,
        // "Recorded" rather than "received" — §5.11 rule 6 holds here too, and
        // this line is read aloud to the person it is about.
        ask: "No reply recorded since we last wrote.",
        context: `${entry.thread.channel}, composed ${days(entry.waitingMs)} ago.`,
        waitedMs: entry.waitingMs,
        urgent: entry.overdue,
      },
    })),
  );
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
function publicationEntries(publications: readonly PublicationNote[]): Entry[] {
  return publications
    .filter((publication) => inFlight(publication) && publication.stage === "internal-review")
    .flatMap((publication) =>
      publication.authors.map((party) => ({
        party,
        item: {
          kind: "publication" as const,
          link: publication.id === "" ? basename(publication.path) : publication.id,
          title: publication.title,
          ask: "Awaiting their comments on the draft.",
          context: publication.journal === "" ? "Internal review." : `For ${publication.journal}.`,
          waitedMs: null,
          urgent: false,
        },
      })),
    );
}

/* ------------------------------------------------------- everything else -- */

function noteEntries(notes: readonly AgendaNote[], now: number): Entry[] {
  const entries: Entry[] = [];

  for (const note of notes) {
    if (HANDLED_ELSEWHERE.has(note.type)) continue;
    if (isSettled(note.frontmatter)) continue;

    // One entry per person per note, under the first field that names them: a
    // note listing somebody as both `owner` and `assignee` is one thing to
    // raise, not two.
    const first = new Map<string, { party: Party; field: string }>();
    for (const key of RESPONSIBILITY_FIELDS) {
      for (const party of partiesIn(note.frontmatter[key])) {
        if (!first.has(party.key)) first.set(party.key, { party, field: key });
      }
    }
    if (first.size === 0) continue;

    const dueMs = parseTimestamp(note.frontmatter["due"]);
    const overdue = dueMs !== null && dueMs < now;

    // §5.7 requires an obligation to say what breaks if it lapses, and a
    // reminder that does not say gets ignored. Carry it through verbatim.
    const consequence = text(note.frontmatter["consequence"]);

    for (const { party, field } of first.values()) {
      entries.push({
        party,
        item: {
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
        },
      });
    }
  }

  return entries;
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
