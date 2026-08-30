/**
 * Reading the live Outlook session into the correspondence contract
 * (CLAUDE.md §5.10 Tier 2, §7 E2).
 *
 * The pure half. A local PowerShell reader drives Outlook's COM automation and
 * hands back JSON; everything here turns one of those records into the same
 * `EmlMessage` the `.eml` and `.msg` parsers return, so threading, dedupe, the
 * review dialog and the note writing are all the code that already exists.
 * That is the whole point, and it is the same argument `msg.ts` made: a
 * conversation half dragged out as files and half synced from the mailbox has
 * to land in **one** thread, and it only does if both paths compute identity
 * the same way. `syntheticId` and `conversationToken` are therefore imported
 * from `msg.ts` rather than reimplemented — two implementations of a thread key
 * is two threads.
 *
 * ## What arrives, and how much of it is trusted
 *
 * A `MailItem` read over COM is the same MAPI property set a `.msg` file holds,
 * so the ordering of preferences is identical:
 *
 *  - **The transport headers win wherever they exist.** A received message
 *    usually keeps its whole internet header block in
 *    `PidTagTransportMessageHeaders`, and that is what the message actually
 *    travelled with — so the `Message-ID` and `References` chain match the
 *    `.eml` path exactly rather than approximately.
 *  - **An Exchange sender is not an address.** Internally the sender property
 *    holds an X.500 directory name, so the SMTP-specific properties are tried
 *    first and a directory name is never passed off as a mailbox. Direction is
 *    decided by matching the sender against your own addresses, and inventing
 *    one would quietly answer a question the item cannot.
 *  - **Synthesised identity is labelled, never disguised** — `msg-conv:` and
 *    `msg-local:`, in their own namespace, exactly as the file reader writes
 *    them.
 *
 * ## What it deliberately does not carry
 *
 * **Attachments are named and left in the mailbox.** Pulling the bytes out
 * would mean either `Attachment.SaveAsFile` to a path outside the vault —
 * which rule 8 forbids — or shipping megabytes of base64 back through a pipe
 * for content §5.10 already calls regulated. Tier 1 exists for this: drag the
 * message itself into the vault and the file reader saves the attachments
 * properly. The note says which files were on the message and where they still
 * are, which is more useful than a silent omission and more honest than a
 * link to something that was never written.
 *
 * Pure module: no Obsidian, no Node, no COM. It is handed a record and returns
 * a message, so every rule above is unit-tested without Outlook running.
 */

import {
  decodeEncodedWords,
  headerValue,
  parseAddressList,
  parseHeaders,
  parseMailDate,
  parseReferences,
  stripAngles,
  type EmlAddress,
  type EmlMessage,
} from "./eml";
import { htmlToText } from "./html";
import { conversationToken, syntheticId } from "./msg";

/** Which default folders the reader may be pointed at. */
export const OUTLOOK_FOLDERS = ["inbox", "sent"] as const;
export type OutlookFolder = (typeof OUTLOOK_FOLDERS)[number];

export const OUTLOOK_FOLDER_LABELS: Record<OutlookFolder, string> = {
  inbox: "Inbox",
  sent: "Sent Items",
};

/** Recipient kinds, as MAPI numbers them. `3` is Bcc and is never kept. */
export interface OutlookRecipient {
  name: string;
  /** SMTP address where one could be resolved; "" for an unresolved entry. */
  address: string;
  /** 1 = To, 2 = Cc, 3 = Bcc. */
  kind: number;
}

/**
 * One item as the bridge script reports it.
 *
 * Every field is a string because it crossed a pipe as JSON, and every one of
 * them is optional in practice — a draft has no sender, an internal item has no
 * headers. `readOutlookItem` narrows an unknown record into this shape rather
 * than trusting it: the script is ours, but a process boundary is still a
 * boundary, and a malformed record must degrade to a problem rather than to a
 * `TypeError` inside a review dialog.
 */
export interface OutlookItem {
  /** MAPI EntryID, hex. Stable within one store; used only for reporting. */
  entryId: string;
  folder: string;
  messageClass: string;
  /** `PidTagTransportMessageHeaders`, or "" when the item never carried one. */
  headers: string;
  subject: string;
  body: string;
  htmlBody: string;
  /** ISO 8601 with an offset, e.g. `2026-08-30T09:15:00+08:00`. */
  sentOn: string;
  receivedTime: string;
  senderName: string;
  /** May be an X.500 directory name; checked before use. */
  senderAddress: string;
  senderAddressType: string;
  senderSmtp: string;
  internetMessageId: string;
  inReplyTo: string;
  references: string;
  /** `PidTagConversationIndex` as lower-case hex, or "". */
  conversationIndex: string;
  recipients: OutlookRecipient[];
  /** Filenames only. The bytes stay in the mailbox — see the header. */
  attachments: string[];
  /** Anything the script itself could not read, in plain English. */
  problems: string[];
}

/* ------------------------------------------------------------- reading -- */

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readRecipients(record: Record<string, unknown>): OutlookRecipient[] {
  const value = record["recipients"];
  if (!Array.isArray(value)) return [];

  const out: OutlookRecipient[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = entry["kind"];
    out.push({
      name: str(entry, "name"),
      address: str(entry, "address"),
      kind: typeof kind === "number" && Number.isFinite(kind) ? kind : 1,
    });
  }
  return out;
}

/** Narrow one JSON record into an item, or null when it is not one at all. */
export function readOutlookItem(value: unknown): OutlookItem | null {
  if (!isRecord(value)) return null;

  return {
    entryId: str(value, "entryId"),
    folder: str(value, "folder"),
    messageClass: str(value, "messageClass"),
    headers: str(value, "headers"),
    subject: str(value, "subject"),
    body: str(value, "body"),
    htmlBody: str(value, "htmlBody"),
    sentOn: str(value, "sentOn"),
    receivedTime: str(value, "receivedTime"),
    senderName: str(value, "senderName"),
    senderAddress: str(value, "senderAddress"),
    senderAddressType: str(value, "senderAddressType"),
    senderSmtp: str(value, "senderSmtp"),
    internetMessageId: str(value, "internetMessageId"),
    inReplyTo: str(value, "inReplyTo"),
    references: str(value, "references"),
    conversationIndex: str(value, "conversationIndex").toLowerCase(),
    recipients: readRecipients(value),
    attachments: strings(value, "attachments"),
    problems: strings(value, "problems"),
  };
}

export interface BridgeReport {
  items: OutlookItem[];
  /** How many items the folder held before the cap and the date filter. */
  scanned: number;
  /** Items the script skipped because they were not mail. */
  skipped: number;
  /** Which Outlook the script attached to, for the diagnostics report. */
  outlookVersion: string;
  problems: string[];
}

export type BridgeOutcome = BridgeReport | { why: string };

/**
 * Read the script's whole reply.
 *
 * A refusal is a sentence, never a thrown error: "Outlook is not running" is
 * the most likely outcome on any given morning and it is not a fault.
 */
export function parseBridgeReport(text: string): BridgeOutcome {
  const trimmed = text.trim();
  if (trimmed === "") return { why: "The Outlook reader returned nothing at all." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { why: "The Outlook reader's reply could not be read as JSON." };
  }

  if (!isRecord(parsed)) return { why: "The Outlook reader's reply was not a record." };

  const error = str(parsed, "error");
  if (error !== "") return { why: error };

  const rawItems = parsed["items"];
  const items: OutlookItem[] = [];
  const problems = strings(parsed, "problems");

  if (Array.isArray(rawItems)) {
    let unreadable = 0;
    for (const entry of rawItems) {
      const item = readOutlookItem(entry);
      if (item === null) unreadable += 1;
      else items.push(item);
    }
    if (unreadable > 0) {
      problems.push(`${unreadable} item${unreadable === 1 ? "" : "s"} came back in a shape this plugin could not read, and were left alone.`);
    }
  }

  const scanned = parsed["scanned"];
  const skipped = parsed["skipped"];

  return {
    items,
    scanned: typeof scanned === "number" && Number.isFinite(scanned) ? scanned : items.length,
    skipped: typeof skipped === "number" && Number.isFinite(skipped) ? skipped : 0,
    outlookVersion: str(parsed, "outlookVersion"),
    problems,
  };
}

/* ---------------------------------------------------------------- dates -- */

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * An ISO timestamp to epoch milliseconds, computed rather than parsed.
 *
 * `new Date(text)` would work here, but the same argument as the feed reader
 * applies: the fields are read out textually and combined with `Date.UTC`, so
 * the result cannot depend on the host's locale or on how a given engine treats
 * a missing offset. The script always emits one, and an item that somehow
 * arrives without is read as local time — the only reading available, and it is
 * the same reading Outlook itself displayed.
 */
export function parseOutlookDate(value: string): number | null {
  const match = ISO.exec(value.trim());
  if (match === null) return null;

  const [, y, mo, d, h, mi, s, zone] = match;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s === undefined ? 0 : Number(s),
  );
  if (!Number.isFinite(utc)) return null;

  if (zone === undefined) {
    // No offset: treat the wall clock as local, which is what Outlook showed.
    const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s === undefined ? 0 : Number(s));
    return local.getTime();
  }
  if (zone === "Z") return utc;

  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
  return utc - sign * offset * 60_000;
}

/* ------------------------------------------------------------ addresses -- */

function address(name: string, addr: string): EmlAddress {
  const clean = addr.trim();
  return {
    name: name.trim().toLowerCase() === clean.toLowerCase() ? "" : name.trim(),
    address: clean,
    key: clean.toLowerCase(),
  };
}

/** An address is only usable when its type is not the Exchange directory. */
function smtpOnly(value: string, type: string): string {
  return type.trim().toUpperCase() === "EX" ? "" : value;
}

/**
 * Who sent it, in descending order of trustworthiness.
 *
 * Identical in spirit to the `.msg` reader, and for the identical reason: an
 * internal message's sender property is `/o=ExchangeLabs/ou=…/cn=…`, which is a
 * directory entry and not a mailbox. Where nothing SMTP-shaped can be had, the
 * sender is recorded **by name with no address** and a problem is raised —
 * never a fabricated one, because direction is computed from this.
 */
function senderOf(item: OutlookItem, fromHeader: string, problems: string[]): EmlAddress[] {
  const fromHeaders = parseAddressList(fromHeader);
  if (fromHeaders.length > 0) return fromHeaders;

  const name = item.senderName.trim();
  const found = [item.senderSmtp, smtpOnly(item.senderAddress, item.senderAddressType)]
    .map((value) => value.trim())
    .find((value) => value.includes("@"));

  if (found === undefined) {
    problems.push(
      name === ""
        ? "This item names no sender, so which way the message went cannot be told from it."
        : `The only sender Outlook holds for ${name} is a directory entry, not an email address, so which way the message went cannot be told from it.`,
    );
    return [];
  }

  return [address(name, found)];
}

function recipientsOf(item: OutlookItem): { to: EmlAddress[]; cc: EmlAddress[] } {
  const to: EmlAddress[] = [];
  const cc: EmlAddress[] = [];

  for (const entry of item.recipients) {
    const addr = entry.address.trim();
    if (!addr.includes("@")) continue;
    // Blind copies are dropped, exactly as the file readers drop them: a Bcc
    // list exists only in the sender's own copy, and writing it into a thread
    // note would disclose what the other recipients were never shown.
    if (entry.kind === 3) continue;
    (entry.kind === 2 ? cc : to).push(address(entry.name, addr));
  }

  return { to, cc };
}

/* ------------------------------------------------------------- assembly -- */

/** Message classes that are mail. Anything else is not a correspondence item. */
export function isMailClass(messageClass: string): boolean {
  const value = messageClass.trim().toLowerCase();
  return value === "" || value === "ipm.note" || value.startsWith("ipm.note.");
}

/**
 * One COM record as the same message every other path produces.
 *
 * The order of preference at every field is the `.msg` reader's, because the
 * two are reading the same MAPI properties through different windows.
 */
export function outlookItemToMessage(item: OutlookItem): EmlMessage {
  const problems = [...item.problems];

  const headers = parseHeaders(item.headers);
  const header = (name: string) => headerValue(headers, name);

  const messageClass = item.messageClass.toLowerCase();
  const signed = messageClass.includes("smime.multipartsigned");
  const encrypted = messageClass === "ipm.note.smime";

  if (signed) {
    problems.push(
      "This message is signed. The signature was not checked — the text below is what Outlook holds, not something this plugin has verified.",
    );
  }
  if (encrypted) {
    problems.push(
      "This message is encrypted, so only its headers could be read. The body and any attachments stay in Outlook.",
    );
  }

  const from = senderOf(item, header("from"), problems);
  const recipients = recipientsOf(item);

  const plain = item.body.trim();
  const bodyFromHtml = plain === "" && item.htmlBody.trim() !== "";
  const body = bodyFromHtml ? htmlToText(item.htmlBody) : item.body;

  const subject =
    decodeEncodedWords(item.subject, problems).trim() || decodeEncodedWords(header("subject"), problems).trim();

  const date =
    parseMailDate(header("date")) ??
    parseOutlookDate(item.sentOn) ??
    parseOutlookDate(item.receivedTime);

  const realId = stripAngles(header("message-id")) || stripAngles(item.internetMessageId);
  const messageId = realId || syntheticId(subject, date, from, body);
  const inReplyTo = stripAngles(header("in-reply-to")) || stripAngles(item.inReplyTo);

  const message: EmlMessage = {
    messageId,
    inReplyTo,
    references: referencesOf(header("references"), item, inReplyTo, realId !== ""),
    subject,
    date,
    from,
    to: recipients.to.length > 0 ? recipients.to : parseAddressList(header("to")),
    cc: recipients.cc.length > 0 ? recipients.cc : parseAddressList(header("cc")),
    replyTo: parseAddressList(header("reply-to")),
    body,
    bodyFromHtml,
    // Named, never fetched. See the module header.
    attachments: [],
    signed,
    encrypted,
    format: "outlook",
    problems,
  };

  if (message.date === null) {
    problems.push("Outlook holds no readable date for this item.");
  }

  return message;
}

/**
 * The conversation chain, with the same last-resort rule as the file reader.
 *
 * The real header first, then MAPI's own copy, then — only when the item offers
 * nothing internet-shaped at all — the Exchange conversation token. That
 * ordering is not a preference: a message that opens its own thread carries a
 * perfectly good id and no `References`, and letting the Exchange token stand
 * in as the root there would key the thread on a GUID no `.eml` can match,
 * splitting one conversation by which route it happened to arrive.
 */
function referencesOf(
  headerValue: string,
  item: OutlookItem,
  inReplyTo: string,
  hasRealId: boolean,
): string[] {
  const fromHeader = parseReferences(headerValue);
  if (fromHeader.length > 0) return fromHeader;

  const mapi = parseReferences(item.references);
  if (mapi.length > 0) return mapi;

  if (inReplyTo !== "") return [];

  const token = conversationToken(unhex(item.conversationIndex), hasRealId);
  return token === null ? [] : [token];
}

/** Hex back to bytes, or null when it is not a whole number of them. */
export function unhex(value: string): Uint8Array | null {
  const text = value.trim().toLowerCase();
  if (text === "" || text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) return null;

  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * What the note should say about the files still sitting in the mailbox.
 *
 * Rendered into the plan's `skipped` list, which the review dialog shows and
 * the note records. An attachment nobody mentions is an attachment somebody
 * assumes was saved.
 */
export function attachmentNotes(item: OutlookItem): string[] {
  return item.attachments.map(
    (name) =>
      `${name} — still in Outlook. A sync reads text only; drag the message into the vault to save its attachments.`,
  );
}
