/**
 * Opening and updating a correspondence thread (CLAUDE.md §5.10, §7 B1).
 *
 * Composing a message is the only moment the plugin learns anything about
 * outreach, so it is the moment a thread is created or appended to. Everything
 * downstream — the ageing list, the holdup view, the chase-up that says "nine
 * days" — is derived from what gets written here.
 *
 * Two things are deliberately *not* recorded:
 *
 *  - **That the message was sent.** We handed a draft to a handler. The user
 *    may have closed it. `composed_only: true` on every message and a
 *    `message-composed` ledger entry (never `message-sent`) is §5.11 rule 6,
 *    and it is the difference between an audit trail and a claim.
 *  - **The message body.** A one-line `summary` goes in; the text does not.
 *    Rule 7 keeps content out of anything derived, and a thread note is read
 *    back into exports and briefings.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AuditEntry } from "../audit/ledger";
import { ulid } from "../id/ulid";
import { toVaultDate, toVaultMinute } from "../time/dates";
import { partiesIn } from "./party";
import { CORRESPONDENCE_TYPE, type Channel, type Thread } from "./thread";

export const DEFAULT_THREAD_PREFIX = "THR";

/**
 * The next free thread label for `year`, `THR-2026-0091`.
 *
 * Same allocation limit as request ids and the same answer: `uid` is what
 * anything durable points at, so two threads briefly claiming `-0091` is a
 * cosmetic collision, not a lost record (§5.2).
 */
export function nextThreadId(
  existingIds: readonly string[],
  year: number,
  prefix = DEFAULT_THREAD_PREFIX,
): string {
  const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`, "i");
  let highest = 0;
  for (const id of existingIds) {
    const match = pattern.exec(id.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${year}-${String(highest + 1).padStart(4, "0")}`;
}

export interface ComposedMessage {
  now: number;
  actor: string;
  channel: Channel;
  /** People, exactly as they are written in the note we took them from. */
  with: readonly string[];
  /** Requests this message is about — human ids or wikilinks, as written. */
  requests: readonly string[];
  subject: string;
  /** How it was composed: "mailto", "teams" or "clipboard". */
  via: string;
  /** One line, in the user's words. Never the message body. */
  summary: string;
}

function messageEntry(input: ComposedMessage): Record<string, unknown> {
  return {
    at: toVaultMinute(input.now),
    dir: "outbound",
    via: input.via,
    // Always true for anything we wrote. See the header.
    composed_only: true,
    summary: input.summary.trim(),
  };
}

/**
 * The ledger entry for composing.
 *
 * `detail` carries the channel, the count of recipients and the request ids —
 * enough to reconstruct what happened, and no names or content (rule 7). The
 * recipients are a count rather than a list because a person's name in a
 * governance ledger is exactly the indirectly-identifying material §2 warns
 * the vault may hold.
 */
export function composedEntry(input: ComposedMessage): AuditEntry {
  const about = input.requests.length === 0 ? "no request" : input.requests.join(", ");
  return {
    ts: toVaultMinute(input.now),
    actor: input.actor,
    action: "message-composed",
    subject: about,
    detail: `${input.channel} via ${input.via} to ${input.with.length} recipient${
      input.with.length === 1 ? "" : "s"
    }; composed, not sent`,
  };
}

export interface NewThread {
  /** Filename within the correspondence folder, extension included. */
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
  audit: AuditEntry[];
}

export interface NewThreadInput extends ComposedMessage {
  /** The human label. Allocate it with `nextThreadId`. */
  id: string;
  /** Defaults to a fresh ULID; injectable so tests are deterministic. */
  uid?: string;
}

/** Open a thread because a first message was composed. */
export function newThread(input: NewThreadInput): NewThread {
  const parties = partiesIn([...input.with]);

  const frontmatter: Record<string, unknown> = {
    type: CORRESPONDENCE_TYPE,
    uid: input.uid ?? ulid(input.now),
    id: input.id,
    channel: input.channel,
    subject: input.subject.trim(),
    thread_key: "",
    with: parties.map((party) => party.raw),
    requests: [...input.requests],
    direction_last: "outbound",
    last_outbound: toVaultDate(input.now),
    last_inbound: null,
    // The ball is with them from the moment we write: that is what makes the
    // thread age into the holdup view without any mailbox access.
    awaiting: "them",
    state: "open",
    messages: [messageEntry(input)],
  };

  return {
    filename: `${input.id}.md`,
    frontmatter,
    body: threadBody(input.subject),
    audit: [composedEntry(input)],
  };
}

/** The note body a new thread starts with. Prose is never rewritten by the plugin. */
export function threadBody(subject: string): string {
  return [
    `# ${subject.trim() === "" ? "Correspondence" : subject.trim()}`,
    "",
    "Paste the message text and any reply below. The plugin only ever reads the",
    "frontmatter above; everything here is yours.",
    "",
  ].join("\n");
}

export interface ThreadPatch {
  /** Frontmatter keys to merge. Unknown keys survive untouched (rule 8). */
  set: Record<string, unknown>;
  /** Appended to `messages`, never replacing it. */
  appendMessage?: Record<string, unknown>;
  audit: AuditEntry[];
}

/**
 * Record another outbound message on a thread that already exists.
 *
 * `existing` is optional only so a caller with nothing to merge can omit it.
 * When it is supplied, the request list is **widened, never replaced**: a
 * chase-up often covers a request the thread did not previously mention, and
 * leaving it out means `threadsForRequest` cannot find this conversation from
 * that request — so its outreach ages invisibly, which is the one thing §5.10
 * exists to prevent. Existing entries keep their exact spelling (rule 8).
 */
export function appendOutbound(input: ComposedMessage, existing?: Thread): ThreadPatch {
  const set: Record<string, unknown> = {
    direction_last: "outbound",
    last_outbound: toVaultDate(input.now),
    awaiting: "them",
    // A thread that was answered and has been written to again is open once
    // more. Leaving it "answered" would take it straight back out of the
    // ageing list it has just earned a place in.
    state: "open",
  };

  if (existing !== undefined) {
    const merged = mergeRequests(existing.requests, input.requests);
    if (merged !== null) set["requests"] = merged;
  }

  return { set, appendMessage: messageEntry(input), audit: [composedEntry(input)] };
}

/** The union, or null when nothing new arrived and the note should not be touched. */
function mergeRequests(
  existing: readonly string[],
  incoming: readonly string[],
): string[] | null {
  const seen = new Set(existing.map(normaliseRef));
  const added = incoming.filter((entry) => {
    const key = normaliseRef(entry);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length === 0 ? null : [...existing, ...added];
}

export interface LoopClosedInput {
  now: number;
  /** What arrived, in one line. Optional — closing the loop must stay one click. */
  summary?: string;
  via?: string;
}

/**
 * Mark a thread answered — the one-click close of the loop (§5.10).
 *
 * **Not logged**, deliberately. §5.6 lists what a consequential action is, and
 * this is none of them: no gate moves, no governance field changes, nothing is
 * deleted or exported. It records that a human replied to a human. Logging
 * every such click would bury the entries that matter in an append-only file
 * nobody then reads.
 */
export function markAnswered(input: LoopClosedInput): ThreadPatch {
  const patch: ThreadPatch = {
    set: {
      direction_last: "inbound",
      last_inbound: toVaultDate(input.now),
      // The ball is with us now. `nobody` would be a lie while the reply is
      // still unread, and would drop the thread out of every view at once.
      awaiting: "me",
      state: "answered",
    },
    audit: [],
  };

  const summary = input.summary?.trim() ?? "";
  if (summary !== "") {
    patch.appendMessage = {
      at: toVaultMinute(input.now),
      dir: "inbound",
      via: input.via ?? "",
      // Absent rather than false: we did not compose this one, so the
      // composed/sent distinction does not apply to it.
      summary,
    };
  }

  return patch;
}

/** Shut a thread for good: no reply is expected and none is being waited for. */
export function markClosed(now: number): ThreadPatch {
  return { set: { awaiting: "nobody", state: "closed", closed: toVaultDate(now) }, audit: [] };
}

/**
 * The thread a new message about these requests belongs to, or null for a new one.
 *
 * Matching is on the people *and* the requests: a second ask to the same person
 * about an unrelated request is a different conversation, and folding it into
 * one thread would make "how long has this been waiting" meaningless. An open
 * thread is preferred over an answered one, and the most recently written wins.
 */
export function threadToContinue(
  threads: readonly Thread[],
  parties: readonly string[],
  requests: readonly string[],
): Thread | null {
  const wanted = new Set(partiesIn([...parties]).map((party) => party.key));
  const requestKeys = new Set(requests.map((entry) => normaliseRef(entry)).filter((r) => r !== ""));
  if (wanted.size === 0) return null;

  const candidates = threads.filter((thread) => {
    if (thread.state === "closed") return false;
    if (!thread.with.some((party) => wanted.has(party.key))) return false;
    if (requestKeys.size === 0) return thread.requests.length === 0;
    return thread.requests.some((entry) => requestKeys.has(normaliseRef(entry)));
  });

  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.state !== b.state) return a.state === "open" ? -1 : 1;
    return (b.lastOutbound ?? 0) - (a.lastOutbound ?? 0);
  })[0]!;
}

function normaliseRef(value: string): string {
  const inner = value.trim().replace(/^\[\[|\]\]$/g, "");
  const target = inner.split("|")[0] ?? inner;
  return (target.split("/").pop() ?? target).trim().toLowerCase();
}
