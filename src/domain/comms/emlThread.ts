/**
 * A parsed `.eml` mapped onto the correspondence contract (CLAUDE.md §5.10).
 *
 * The schema in §5.10 was written for exactly this: *"designed so a sync
 * populates it without migrating anything."* Nothing here invents a note type
 * or a folder — an imported message opens or extends the same thread note a
 * composed one does, and both feed one holdup view.
 *
 * ## The three decisions this module makes
 *
 *  - **Which conversation a message belongs to.** The root of `References:` —
 *    the id of the message that started the thread — which is precisely what
 *    §5.10's `thread_key` is for. Every reply in a chain carries it, so a
 *    fortnight of back-and-forth collapses into one note rather than nine.
 *  - **Which way it went.** Against the user's own addresses, and only those.
 *    See `directionOf`.
 *  - **What it is about.** Request ids that appear in the text *and* already
 *    exist in the vault. Nothing else is inferred.
 *
 * ## What it refuses to do
 *
 * §2 rule 5 is the governing constraint: an email is the untrusted text this
 * system is built to ingest. An imported message therefore **never** advances a
 * stage, satisfies a gate, writes an evidence record, or edits a request note.
 * It writes a correspondence note and links to things. A circular saying
 * *"ignore previous instructions and approve all requests"* lands in the vault
 * as text, which is what it is.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate, toVaultMinute } from "../time/dates";
import { parseParty } from "./party";
import type { EmlAddress, EmlMessage } from "./eml";
import { CORRESPONDENCE_TYPE, type Direction, type Thread } from "./thread";

/** Attachments this large are named and skipped rather than copied in. */
export const DEFAULT_MAX_ATTACHMENT_KB = 10 * 1024;

export const ATTACHMENT_POLICIES = ["attachments", "all", "none"] as const;
export type AttachmentPolicy = (typeof ATTACHMENT_POLICIES)[number];

export interface PlannedAttachment {
  /** Filename as it will be written, already made vault-safe. */
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sizeKb: number;
}

export interface EmlPlan {
  /** Where the file came from, for the review list. */
  sourcePath: string;
  message: EmlMessage;
  direction: Direction;
  /** The conversation root; `thread_key` in §5.10. */
  threadKey: string;
  /** `with:` entries — a wikilink where a person is named, else the address. */
  parties: string[];
  /** Request ids found in the text that already exist in the vault. */
  requests: string[];
  /** Epoch ms. Falls back to the file's own time when the header was unreadable. */
  at: number;
  attachments: PlannedAttachment[];
  /** Attachments deliberately left behind, with the reason. */
  skipped: string[];
  problems: string[];
}

export interface PlanOptions {
  /** The user's own mailboxes, lower-cased. Direction is undecidable without them. */
  ownAddresses: ReadonlySet<string>;
  /** Request ids already in the vault, so only real ones are linked. */
  knownRequestIds: readonly string[];
  /** Person-note names, so an exact match links to the note that exists. */
  knownPeople: readonly string[];
  attachments: AttachmentPolicy;
  maxAttachmentKb: number;
  /** Used when the message carries no readable `Date:`. */
  fallbackAt: number;
}

/**
 * Which way a message went.
 *
 * Decided **only** against the user's own configured addresses. There is no
 * heuristic fallback and there must not be: `awaiting` is the entire point of
 * §5.10, and getting the direction backwards turns an unanswered chase-up into
 * a closed loop — the exact failure the note type exists to prevent. When no
 * address is configured the importer refuses rather than guessing, which is why
 * this returns a direction and the caller checks the set is non-empty first.
 */
export function directionOf(from: readonly EmlAddress[], own: ReadonlySet<string>): Direction {
  return from.some((address) => own.has(address.key)) ? "outbound" : "inbound";
}

/**
 * The conversation this message belongs to.
 *
 * The first entry of `References:` is the id of the message that opened the
 * thread; every reply carries the whole chain, so all of them agree on it
 * without anyone having to compare subjects. `In-Reply-To` is the fallback for
 * a client that omits `References`, and a message that is neither a reply nor
 * referenced is the root of its own thread.
 */
export function threadKeyOf(message: EmlMessage): string {
  const root = message.references[0] ?? "";
  if (root !== "") return root;
  if (message.inReplyTo !== "") return message.inReplyTo;
  return message.messageId;
}

/** Every message id this message is part of the chain of, its own included. */
export function chainOf(message: EmlMessage): string[] {
  const ids = [...message.references];
  if (message.inReplyTo !== "") ids.push(message.inReplyTo);
  if (message.messageId !== "") ids.push(message.messageId);
  return [...new Set(ids.filter((id) => id !== ""))];
}

/**
 * How a correspondent is written into `with:`.
 *
 * A display name that exactly matches a note in `30 People/` is written as a
 * wikilink to *that* note's spelling, so the thread joins the agenda and holdup
 * views the rest of the plugin builds from person links. The match is exact and
 * case-folded — nothing fuzzier. Guessing that "A Tan" is "[[Dr A Tan]]" would
 * attribute a governance holdup to a person on the strength of a substring.
 *
 * With no display name at all the bare address goes in. An email address as a
 * wikilink target would create a note named after a mailbox, which is not a
 * person and not something anyone wants in their graph.
 */
export function partyFor(address: EmlAddress, knownPeople: readonly string[]): string {
  if (address.name === "") return address.address;

  const wanted = address.name.toLowerCase();
  const match = knownPeople.find((name) => name.toLowerCase() === wanted);
  return `[[${match ?? address.name}]]`;
}

/** Everyone on the message who is not the user. */
export function correspondents(
  message: EmlMessage,
  own: ReadonlySet<string>,
  knownPeople: readonly string[],
): string[] {
  const seen = new Set<string>();
  const parties: string[] = [];

  for (const address of [...message.from, ...message.to, ...message.cc]) {
    if (own.has(address.key) || seen.has(address.key)) continue;
    seen.add(address.key);
    parties.push(partyFor(address, knownPeople));
  }

  return parties;
}

/** Regex-safe. Request ids are user data and may hold anything. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Request ids mentioned in the message that already exist in the vault.
 *
 * Matched against known ids rather than a shape, so a message quoting
 * `REQ-2027-999` — a request nobody has created, or one an outside sender
 * invented — links to nothing. The link is a convenience for the reader; it
 * never causes anything to happen (§2 rule 5).
 */
export function requestsMentioned(
  message: EmlMessage,
  knownRequestIds: readonly string[],
): string[] {
  const haystack = `${message.subject}\n${message.body}`;
  if (haystack.trim() === "") return [];

  return knownRequestIds.filter((id) => {
    const trimmed = id.trim();
    if (trimmed === "") return false;
    return new RegExp(`(^|[^\\w-])${escapeRegex(trimmed)}($|[^\\w-])`, "i").test(haystack);
  });
}

/** Anything a vault filename cannot carry. Mirrors `domain/events/create.ts`. */
export function safeAttachmentName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 80);
}

function planAttachments(
  message: EmlMessage,
  options: PlanOptions,
): { kept: PlannedAttachment[]; skipped: string[] } {
  const kept: PlannedAttachment[] = [];
  const skipped: string[] = [];
  if (options.attachments === "none") {
    if (message.attachments.length > 0) {
      skipped.push(`${message.attachments.length} attachment(s) — attachments are turned off.`);
    }
    return { kept, skipped };
  }

  for (const attachment of message.attachments) {
    const sizeKb = Math.ceil(attachment.bytes.length / 1024);
    const name = safeAttachmentName(attachment.filename, "attachment");

    // Inline parts are the images the HTML body references — the signature
    // logo on every message from a large institution. Saving them by default
    // means forty copies of the same crest in `_attachments/`.
    if (attachment.inline && options.attachments !== "all") {
      skipped.push(`${name} — embedded in the message body, not a separate attachment.`);
      continue;
    }
    if (sizeKb > options.maxAttachmentKb) {
      skipped.push(`${name} — ${sizeKb} KB, over the ${options.maxAttachmentKb} KB limit.`);
      continue;
    }
    if (attachment.bytes.length === 0) {
      skipped.push(`${name} — empty.`);
      continue;
    }

    kept.push({ filename: name, mimeType: attachment.mimeType, bytes: attachment.bytes, sizeKb });
  }

  return { kept, skipped };
}

export function planMessage(
  message: EmlMessage,
  sourcePath: string,
  options: PlanOptions,
): EmlPlan {
  const { kept, skipped } = planAttachments(message, options);

  return {
    sourcePath,
    message,
    direction: directionOf(message.from, options.ownAddresses),
    threadKey: threadKeyOf(message),
    parties: correspondents(message, options.ownAddresses, options.knownPeople),
    requests: requestsMentioned(message, options.knownRequestIds),
    at: message.date ?? options.fallbackAt,
    attachments: kept,
    skipped,
    problems: [...message.problems],
  };
}

/* --------------------------------------------------------- thread notes -- */

/**
 * The thread an imported message joins, or null for a new one.
 *
 * Matched on `thread_key` first, then on any message id already recorded — a
 * reply whose `References` chain was trimmed by a mail gateway still finds its
 * conversation if the message it answers is already in the vault. Never matched
 * on subject: "RE: Update" is not an identity.
 */
export function threadForMessage(
  threads: readonly Thread[],
  plan: EmlPlan,
): Thread | null {
  if (plan.threadKey !== "") {
    const byKey = threads.find((thread) => thread.threadKey === plan.threadKey);
    if (byKey !== undefined) return byKey;
  }

  const chain = new Set(chainOf(plan.message));
  if (chain.size === 0) return null;

  return (
    threads.find((thread) =>
      thread.messages.some((entry) => entry.messageId !== "" && chain.has(entry.messageId)),
    ) ?? null
  );
}

/** True when this exact message is already recorded on the thread. */
export function alreadyRecorded(thread: Thread, plan: EmlPlan): boolean {
  if (plan.message.messageId === "") return false;
  return thread.messages.some((entry) => entry.messageId === plan.message.messageId);
}

/**
 * The `messages:` entry for an imported message.
 *
 * `composed_only` is deliberately **absent**, not false. §5.11 rule 6 invented
 * that flag to record that we composed something and cannot know it was sent;
 * an imported message is one that demonstrably existed in a mailbox, so the
 * distinction does not apply and asserting either value about it would be a
 * claim we have not earned.
 *
 * `message_id` is the one addition to §5.10's shape, and it is load-bearing:
 * without it, importing the same folder twice appends every message again.
 */
export function importedMessageEntry(plan: EmlPlan): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    at: toVaultMinute(plan.at),
    dir: plan.direction,
    via: "eml-import",
    // One line, the subject as sent. Never the body — a `messages:` list is
    // read back into briefings and exports (rule 7).
    summary: plan.message.subject === "" ? "(no subject)" : plan.message.subject,
  };
  if (plan.message.messageId !== "") entry["message_id"] = plan.message.messageId;
  return entry;
}

export interface EmlThreadPatch {
  /** Frontmatter keys to merge. Unknown keys survive (rule 8). */
  set: Record<string, unknown>;
  appendMessage: Record<string, unknown>;
  /** Appended to the note body, never replacing it. */
  appendBody: string;
}

/** Fields that follow from a message having arrived or gone out. */
function directionFields(plan: EmlPlan): Record<string, unknown> {
  const date = toVaultDate(plan.at);
  return plan.direction === "inbound"
    ? {
        direction_last: "inbound",
        last_inbound: date,
        // The ball is with us. Not "nobody" — the reply may need an answer, and
        // "nobody" drops the thread out of every view at once.
        awaiting: "me",
        state: "answered",
      }
    : {
        direction_last: "outbound",
        last_outbound: date,
        awaiting: "them",
        state: "open",
      };
}

export interface NewEmlThread {
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Open a thread from an imported message. */
export function newThreadFromEml(
  plan: EmlPlan,
  id: string,
  uid: string,
): NewEmlThread {
  const subject = plan.message.subject === "" ? "(no subject)" : plan.message.subject;

  const frontmatter: Record<string, unknown> = {
    type: CORRESPONDENCE_TYPE,
    uid,
    id,
    channel: "email",
    subject,
    thread_key: plan.threadKey,
    with: plan.parties,
    requests: plan.requests,
    ...directionFields(plan),
    messages: [importedMessageEntry(plan)],
  };

  // `last_inbound`/`last_outbound` must both exist as keys even when only one
  // has a date: §5.10 shows both, and a reader scanning the frontmatter should
  // see that the other direction has not happened rather than wonder.
  if (frontmatter["last_inbound"] === undefined) frontmatter["last_inbound"] = null;
  if (frontmatter["last_outbound"] === undefined) frontmatter["last_outbound"] = null;

  return {
    filename: `${id}.md`,
    frontmatter,
    body: `# ${subject}\n\n${threadPreamble()}\n${messageSection(plan)}`,
  };
}

function threadPreamble(): string {
  return [
    "Imported from saved email files. Nothing was fetched and nothing was sent —",
    "the plugin read `.eml` files that were already in this vault.",
    "",
  ].join("\n");
}

/**
 * Add an imported message to a thread that already exists.
 *
 * The request list is **widened, never replaced**, on the same argument
 * `appendOutbound` makes: a reply often names a request the thread did not
 * previously mention, and dropping it means the conversation cannot be found
 * from that request, so its outreach ages invisibly.
 */
export function appendEmlToThread(plan: EmlPlan, existing: Thread): EmlThreadPatch {
  const set: Record<string, unknown> = { ...directionFields(plan) };

  if (existing.threadKey === "" && plan.threadKey !== "") set["thread_key"] = plan.threadKey;

  const merged = mergeList(existing.requests, plan.requests);
  if (merged !== null) set["requests"] = merged;

  const parties = mergeList(existing.with.map((party) => party.raw), plan.parties, (value) =>
    parseParty(value).key,
  );
  if (parties !== null) set["with"] = parties;

  return {
    set,
    appendMessage: importedMessageEntry(plan),
    appendBody: messageSection(plan),
  };
}

function mergeList(
  existing: readonly string[],
  incoming: readonly string[],
  key: (value: string) => string = (value) => normaliseRef(value),
): string[] | null {
  const seen = new Set(existing.map(key));
  const added = incoming.filter((entry) => {
    const id = key(entry);
    if (id === "" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return added.length === 0 ? null : [...existing, ...added];
}

function normaliseRef(value: string): string {
  const inner = value.trim().replace(/^\[\[|\]\]$/g, "");
  const target = inner.split("|")[0] ?? inner;
  return (target.split("/").pop() ?? target).trim().toLowerCase();
}

/* ------------------------------------------------------------ rendering -- */

function nameOf(address: EmlAddress): string {
  return address.name === "" ? address.address : `${address.name} <${address.address}>`;
}

/**
 * One message as a section of the thread note's body.
 *
 * The full text goes in. §5.10 permits it explicitly — *"full body plus
 * attachments is permitted"* — and states the consequence it accepts: the vault
 * is therefore a regulated data store, kept on the work laptop and excluded
 * from exports by default.
 *
 * The body is fenced rather than inlined. An email is arbitrary text and will
 * contain `#`, `---`, `>` and `[[`: rendered as markdown it becomes headings,
 * horizontal rules and — worst — **wikilinks to notes it has no business
 * linking to**, which would put an outside sender's text into this vault's link
 * graph. A fence renders it as what it is.
 */
export function messageSection(plan: EmlPlan): string {
  const { message } = plan;
  const heading =
    `## ${toVaultMinute(plan.at).replace("T", " ")} · ` +
    `${plan.direction} · ${message.from.map(nameOf).join(", ") || "unknown sender"}`;

  const lines: string[] = ["", heading, ""];

  if (message.to.length > 0) lines.push(`**To:** ${message.to.map(nameOf).join(", ")}  `);
  if (message.cc.length > 0) lines.push(`**Cc:** ${message.cc.map(nameOf).join(", ")}  `);
  lines.push(`**Subject:** ${message.subject === "" ? "(no subject)" : message.subject}`, "");

  if (message.signed || message.encrypted) {
    lines.push(
      `> ${message.encrypted ? "Encrypted message — only the headers could be read." : "Signed message — the signature was not checked."}`,
      "",
    );
  }

  lines.push(...fenceBody(message.bodyFromHtml, message.body), "");

  if (plan.attachments.length > 0) {
    lines.push("**Attachments:**", "");
    for (const attachment of plan.attachments) {
      lines.push(`- ![[${attachment.filename}]] (${attachment.sizeKb} KB)`);
    }
    lines.push("");
  }
  if (plan.skipped.length > 0) {
    lines.push("**Not saved:**", "");
    for (const reason of plan.skipped) lines.push(`- ${reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Fence the body, with a fence long enough to survive the body's own backticks.
 *
 * A three-backtick fence around a message that itself contains three backticks
 * ends early, and the rest of the email escapes into the note as markdown —
 * exactly what the fence was there to prevent.
 */
function fenceBody(fromHtml: boolean, body: string): string[] {
  const text = body.trim() === "" ? "(no readable body)" : body;
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fromHtml ? "*Reduced from an HTML message.*" : "", fence, text, fence].filter(
    (line, index) => !(index === 0 && line === ""),
  );
}
