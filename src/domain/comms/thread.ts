/**
 * Correspondence threads and outreach ageing (CLAUDE.md §5.10, §7 B1).
 *
 * **One note per thread, not per message and not per request.** A thread can
 * touch several requests, and "no reply in nine days" is a property of the
 * conversation, not of any one request. Storing it the other way round would
 * churn every request note each time somebody replies and would give no home to
 * the question this module exists to answer.
 *
 * **Tier 0: we know what we composed, and nothing else.** The plugin has no
 * mailbox access, so it can only age outreach it wrote itself. That turns out
 * to be enough — *"emailed Dr Tan 9 days ago about REQ-2026-014, nothing
 * recorded back"* needs no API. Every message we compose records
 * `composed_only: true`, because we know it was composed and cannot know it was
 * sent, and §5.11 rule 6 is explicit that an audit trail claiming otherwise is
 * worse than none.
 *
 * Pure module: no Obsidian, no Node.
 */

import { DAY_MS, parseTimestamp } from "../time/dates";
import { partiesIn, type Party } from "./party";

export const CORRESPONDENCE_TYPE = "correspondence";

export const CHANNELS = ["email", "teams", "meeting", "phone"] as const;
export type Channel = (typeof CHANNELS)[number];

export const DIRECTIONS = ["outbound", "inbound"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Who the ball is with. §5.10: this is the whole point of the note type, and it
 * mirrors `blocked_on` on a request so both feed one holdup view.
 */
export const AWAITING = ["them", "me", "nobody"] as const;
export type Awaiting = (typeof AWAITING)[number];

export const THREAD_STATES = ["open", "answered", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export interface ThreadMessage {
  at: number | null;
  dir: Direction;
  /** How it was composed: "mailto", "teams", "clipboard", or a hand-written note. */
  via: string;
  /** True when we composed it and cannot know whether it was sent (§5.11 rule 6). */
  composedOnly: boolean;
  /** A one-line human summary. Never the message body. */
  summary: string;
}

export interface Thread {
  uid: string;
  id: string;
  channel: Channel;
  subject: string;
  /** Message-id root or Teams conversation id, for a future Tier 2 sync (§5.10). */
  threadKey: string;
  with: Party[];
  /** Request ids or wikilinks, exactly as written. */
  requests: string[];
  directionLast: Direction | null;
  lastOutbound: number | null;
  lastInbound: number | null;
  awaiting: Awaiting;
  state: ThreadState;
  messages: ThreadMessage[];
  raw: Record<string, unknown>;
}

export interface ParsedThread {
  thread: Thread;
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

/* --------------------------------------------------------------- reading -- */

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  problems: string[],
): T {
  const text = str(value);
  if (text === "") return fallback;
  if ((allowed as readonly string[]).includes(text)) return text as T;
  problems.push(
    `\`${field}: ${text}\` is not one of: ${allowed.join(", ")}. Treating it as "${fallback}".`,
  );
  return fallback;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(str).filter((entry) => entry !== "");
}

function readMessages(value: unknown, problems: string[]): ThreadMessage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push("`messages` is not a list, so no message history could be read.");
    return [];
  }

  const messages: ThreadMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const dir = str(record["dir"]) === "inbound" ? "inbound" : "outbound";
    messages.push({
      at: parseTimestamp(record["at"]),
      dir,
      via: str(record["via"]),
      composedOnly: record["composed_only"] === true,
      summary: str(record["summary"]),
    });
  }

  // Chronological, undated last: an entry with no timestamp cannot be placed,
  // and guessing where it goes would corrupt the ageing arithmetic below.
  return messages.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Derive who is waiting from the dates, for a note that does not say.
 *
 * `awaiting` is the declared field and wins when it is present, because a human
 * may know something the dates do not — a reply that arrived by phone, or an
 * ask that was withdrawn. This is only the fallback.
 */
export function deriveAwaiting(lastOutbound: number | null, lastInbound: number | null): Awaiting {
  if (lastOutbound === null) return lastInbound === null ? "nobody" : "me";
  if (lastInbound === null) return "them";
  return lastInbound >= lastOutbound ? "me" : "them";
}

export function parseThread(
  frontmatter: Record<string, unknown>,
  fallbackId: string,
): ParsedThread {
  const problems: string[] = [];

  const lastOutbound = parseTimestamp(frontmatter["last_outbound"]);
  const lastInbound = parseTimestamp(frontmatter["last_inbound"]);
  const messages = readMessages(frontmatter["messages"], problems);

  const declaredAwaiting = str(frontmatter["awaiting"]);
  const awaiting =
    declaredAwaiting === ""
      ? deriveAwaiting(lastOutbound, lastInbound)
      : oneOf(declaredAwaiting, AWAITING, "nobody", "awaiting", problems);

  const directionLastRaw = str(frontmatter["direction_last"]);
  const directionLast =
    directionLastRaw === ""
      ? (messages[messages.length - 1]?.dir ?? null)
      : oneOf(directionLastRaw, DIRECTIONS, "outbound", "direction_last", problems);

  const thread: Thread = {
    uid: str(frontmatter["uid"]),
    id: str(frontmatter["id"]) || fallbackId,
    channel: oneOf(frontmatter["channel"], CHANNELS, "email", "channel", problems),
    subject: str(frontmatter["subject"]),
    threadKey: str(frontmatter["thread_key"]),
    with: partiesIn(frontmatter["with"]),
    requests: stringList(frontmatter["requests"]),
    directionLast,
    lastOutbound,
    lastInbound,
    awaiting,
    state: oneOf(frontmatter["state"], THREAD_STATES, "open", "state", problems),
    messages,
    raw: frontmatter,
  };

  if (thread.with.length === 0) {
    problems.push("`with` names nobody, so this thread cannot appear in the holdup view.");
  }

  return { thread, problems };
}

/* ---------------------------------------------------------------- ageing -- */

/**
 * How long before an unanswered message is worth chasing.
 *
 * Seven days rather than three: a clinician who has been asked for a signature
 * is not ignoring you after 72 hours, and a list that says so every week stops
 * being read. Configurable, because a facility's norms are not ours to fix.
 */
export const DEFAULT_CHASE_DAYS = 7;

export interface AgedThread {
  thread: Thread;
  /** Since the last outbound message. Null when the thread has no usable date. */
  waitingMs: number | null;
  waitingDays: number | null;
  /** Past the chase interval. */
  overdue: boolean;
}

export interface AgeingOptions {
  now: number;
  chaseDays?: number;
  /** Include threads inside the interval too, for a full list. */
  includeFresh?: boolean;
}

/**
 * Outreach that has not been answered, longest wait first.
 *
 * A closed thread is out: closing it is the explicit statement that no reply is
 * expected. An `answered` thread is also out — the loop is shut. What remains
 * is an open conversation where the ball is with them.
 *
 * A thread with no `last_outbound` is *kept* when it is awaiting them, with a
 * null wait. It cannot be sorted by age, but silently dropping the one thread
 * whose dates are missing is how a chase-up gets forgotten; it lands at the end
 * of the list saying it has no date rather than vanishing.
 */
export function agedOutreach(
  threads: readonly Thread[],
  options: AgeingOptions,
): AgedThread[] {
  const chaseMs = (options.chaseDays ?? DEFAULT_CHASE_DAYS) * DAY_MS;
  const aged: AgedThread[] = [];

  for (const thread of threads) {
    if (thread.state === "closed" || thread.state === "answered") continue;
    if (thread.awaiting !== "them") continue;

    const waitingMs = thread.lastOutbound === null ? null : options.now - thread.lastOutbound;
    const overdue = waitingMs !== null && waitingMs >= chaseMs;
    if (!overdue && options.includeFresh !== true && waitingMs !== null) continue;

    aged.push({
      thread,
      waitingMs,
      waitingDays: waitingMs === null ? null : Math.round(waitingMs / DAY_MS),
      overdue,
    });
  }

  return aged.sort((a, b) => (b.waitingMs ?? -1) - (a.waitingMs ?? -1));
}

/** Aged outreach grouped by person, so one chase-up covers the lot (§7 B1). */
export interface OutreachParty {
  party: Party;
  threads: AgedThread[];
  longestWaitMs: number | null;
}

export function groupOutreachByParty(aged: readonly AgedThread[]): OutreachParty[] {
  const byKey = new Map<string, { party: Party; threads: AgedThread[] }>();

  for (const entry of aged) {
    for (const party of entry.thread.with) {
      const group = byKey.get(party.key) ?? { party, threads: [] };
      group.threads.push(entry);
      byKey.set(party.key, group);
    }
  }

  return [...byKey.values()]
    .map((group) => ({
      party: group.party,
      threads: group.threads,
      longestWaitMs: group.threads.reduce<number | null>(
        (worst, entry) => (entry.waitingMs === null ? worst : Math.max(worst ?? 0, entry.waitingMs)),
        null,
      ),
    }))
    .sort((a, b) => (b.longestWaitMs ?? -1) - (a.longestWaitMs ?? -1));
}

/** Threads that mention a request, by its human id or a wikilink to it. */
export function threadsForRequest(threads: readonly Thread[], requestId: string): Thread[] {
  const needle = requestId.trim().toLowerCase();
  if (needle === "") return [];
  return threads.filter((thread) =>
    thread.requests.some((entry) => {
      const target = entry.replace(/^\[\[|\]\]$/g, "").split("|")[0] ?? entry;
      return (target.split("/").pop() ?? target).trim().toLowerCase() === needle;
    }),
  );
}
