/**
 * `.msg` parsing — Outlook's own message format (CLAUDE.md §5.10, email
 * Tier 1).
 *
 * Classic Outlook saves a message as `.msg`, not `.eml`. There is no RFC 5322
 * anywhere in the file: it is a compound file (see `cfb.ts`) holding MAPI
 * properties, one stream per property, named after the property's numeric tag.
 * The subject lives in `__substg1.0_0037001F`, and that is the whole idea.
 *
 * ## The one design decision worth stating
 *
 * This module returns an `EmlMessage` — the *same* type `eml.ts` produces.
 * Nothing downstream knows or cares which format a message arrived in:
 * threading, deduplication, the review dialog, the note writing and the
 * attachment policy are all shared. A conversation where you were sent one
 * reply as `.eml` and saved another as `.msg` lands in one thread note, which
 * would not happen if this had its own parallel pipeline.
 *
 * ## Where the internet headers come from
 *
 * A received message usually carries its original headers verbatim in
 * `PidTagTransportMessageHeaders`. Where that exists it is preferred over every
 * MAPI equivalent, because it is the actual header block the message travelled
 * with — same `Message-ID`, same `References` chain — so threading matches the
 * `.eml` path exactly rather than approximately.
 *
 * Where it does not exist (a message you sent, an internal Exchange item), the
 * fields are rebuilt from MAPI properties and, if there is still no usable
 * identity, synthesised. Synthesised ids are marked as such and live in their
 * own namespace — see `syntheticId`. They are never made to look like real
 * internet message ids, because a vault is a record and a fabricated
 * `Message-ID` in it would be a small lie that outlives the import.
 *
 * Everything read here is untrusted text (§2 rule 5). This module returns data.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isCompoundFile, readCompoundFile, type CfbEntry } from "./cfb";
import {
  decodeText,
  headerValue,
  parseAddressList,
  parseHeaders,
  parseMailDate,
  parseReferences,
  stripAngles,
  type EmlAddress,
  type EmlAttachment,
  type EmlMessage,
} from "./eml";
import { htmlToText } from "./html";
import { decompressRtf, readRtf } from "./rtf";

/* ------------------------------------------------------ property tags -- */

/** Property types, in the low half of a tag. */
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_SYSTIME = 0x0040;

/**
 * The properties this reads, by their MAPI ids (MS-OXPROPS).
 *
 * Named rather than inlined because `0x007d` tells a future reader nothing, and
 * every one of these was looked up once already.
 */
const TAG = {
  messageClass: 0x001a,
  subject: 0x0037,
  clientSubmitTime: 0x0039,
  sentRepresentingName: 0x0042,
  sentRepresentingAddress: 0x0065,
  conversationTopic: 0x0070,
  conversationIndex: 0x0071,
  transportHeaders: 0x007d,
  body: 0x1000,
  rtfCompressed: 0x1009,
  html: 0x1013,
  internetReferences: 0x1039,
  internetMessageId: 0x1035,
  inReplyToId: 0x1042,
  senderName: 0x0c1a,
  senderAddressType: 0x0c1e,
  senderAddress: 0x0c1f,
  deliveryTime: 0x0e06,
  normalizedSubject: 0x0e1d,
  lastModified: 0x3008,
  displayName: 0x3001,
  addressType: 0x3002,
  emailAddress: 0x3003,
  recipientType: 0x0c15,
  attachFilename: 0x3704,
  attachMethod: 0x3705,
  attachLongFilename: 0x3707,
  attachExtension: 0x3703,
  attachData: 0x3701,
  attachMimeTag: 0x370e,
  attachContentId: 0x3712,
  attachHidden: 0x7ffe,
  smtpAddress: 0x39fe,
  senderSmtpAddress: 0x5d01,
  sentRepresentingSmtpAddress: 0x5d02,
  internetCodepage: 0x3fde,
  messageCodepage: 0x3ffd,
} as const;

/** `PidTagRecipientType` values (MS-OXOMSG §2.2.3.1). */
const RECIPIENT_TO = 1;
const RECIPIENT_CC = 2;
const RECIPIENT_BCC = 3;

/** `PidTagAttachMethod` value for an attached message rather than a file. */
const ATTACH_EMBEDDED_MESSAGE = 5;

const SUBSTG_PREFIX = "__substg1.0_";
const PROPERTIES_STREAM = "__properties_version1.0";
const RECIPIENT_PREFIX = "__recip_version1.0_";
const ATTACHMENT_PREFIX = "__attach_version1.0_";

/** True when a file looks like a `.msg` rather than an `.eml`. */
export function isMsgFile(bytes: Uint8Array): boolean {
  return isCompoundFile(bytes);
}

/* --------------------------------------------------------- property bag -- */

/**
 * The properties of one storage — the message, a recipient or an attachment.
 *
 * Variable-length values (strings, binaries) each live in their own stream;
 * fixed-length ones (times, integers, booleans) are packed into a single table
 * whose header size differs by what kind of storage it is.
 */
class Properties {
  private readonly variable = new Map<number, CfbEntry>();
  private readonly fixed = new Map<number, DataView>();
  private codepage = "";

  constructor(storage: CfbEntry, headerSize: number) {
    for (const child of storage.children) {
      if (child.kind !== "stream") continue;
      if (child.name === PROPERTIES_STREAM) {
        this.readTable(child, headerSize);
        continue;
      }
      // `__substg1.0_` plus eight hex digits. A longer name is a multi-valued
      // property's element, which nothing here reads.
      if (!child.name.startsWith(SUBSTG_PREFIX) || child.name.length !== SUBSTG_PREFIX.length + 8) {
        continue;
      }
      const tag = Number.parseInt(child.name.slice(SUBSTG_PREFIX.length), 16);
      if (Number.isFinite(tag)) this.variable.set(tag >>> 0, child);
    }
  }

  private readTable(entry: CfbEntry, headerSize: number): void {
    const bytes = entry.read();
    if (bytes.length <= headerSize) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let at = headerSize; at + 16 <= bytes.length; at += 16) {
      const tag = view.getUint32(at, true) >>> 0;
      this.fixed.set(tag, new DataView(bytes.buffer, bytes.byteOffset + at + 8, 8));
    }
  }

  /**
   * The code page eight-bit strings in this storage are written in.
   *
   * Resolved once and cached. Falls back to windows-1252 rather than UTF-8:
   * an eight-bit MAPI string with no declared code page came from a Windows
   * client, and reading its smart quotes as UTF-8 yields replacement characters
   * where `eml.ts` would have got the quote right.
   */
  charset(): string {
    if (this.codepage !== "") return this.codepage;
    const declared = this.int(TAG.internetCodepage) ?? this.int(TAG.messageCodepage);
    this.codepage = codepageLabel(declared);
    return this.codepage;
  }

  /** A string property, Unicode preferred over the eight-bit spelling. */
  str(id: number, problems: string[] = []): string {
    const unicode = this.variable.get(tagOf(id, PT_UNICODE));
    if (unicode !== undefined) return unterminated(utf16le(unicode.read()));

    const ansi = this.variable.get(tagOf(id, PT_STRING8));
    if (ansi !== undefined) {
      return unterminated(decodeText(ansi.read(), this.charset(), problems));
    }

    return "";
  }

  bin(id: number): Uint8Array | null {
    return this.variable.get(tagOf(id, PT_BINARY))?.read() ?? null;
  }

  int(id: number): number | null {
    return this.fixed.get(tagOf(id, PT_LONG))?.getInt32(0, true) ?? null;
  }

  bool(id: number): boolean | null {
    const value = this.fixed.get(tagOf(id, PT_BOOLEAN));
    return value === undefined ? null : value.getUint16(0, true) !== 0;
  }

  /** A `PT_SYSTIME` as epoch milliseconds, or null when absent or unset. */
  time(id: number): number | null {
    const value = this.fixed.get(tagOf(id, PT_SYSTIME));
    if (value === undefined) return null;

    // FILETIME counts 100-nanosecond ticks from 1601. The value passes 2^53
    // in 1970, so this cannot be done in a double without losing days.
    const ticks =
      (BigInt(value.getUint32(4, true)) << 32n) | BigInt(value.getUint32(0, true));
    if (ticks === 0n) return null;

    const ms = Number(ticks / 10_000n) - 11_644_473_600_000;
    // An unset time is sometimes written as the maximum FILETIME rather than
    // zero, which would otherwise date a message to the year 30828.
    return ms > 0 && ms < 253_402_300_800_000 ? ms : null;
  }
}

const tagOf = (id: number, type: number) => (((id << 16) >>> 0) | type) >>> 0;

function utf16le(bytes: Uint8Array): string {
  return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
}

/**
 * A MAPI string up to its terminator.
 *
 * MS-OXMSG says a string stream holds the characters and no terminating null.
 * Real Outlook writes one anyway — found in the subject and in a recipient's
 * address of an ordinary received message. Cutting at the first U+0000 is the
 * C-string reading the writer evidently intended, and none of these properties
 * can legitimately contain one.
 *
 * This is not cosmetic. Direction is decided by matching an address against
 * the user's own, and `a@b.org\u0000` matches nothing — a message you sent would
 * be filed as one you received, which is the wrong answer to the only question
 * the holdup views ask.
 */
function unterminated(value: string): string {
  const end = value.indexOf("\u0000");
  return end === -1 ? value : value.slice(0, end);
}

/**
 * A MAPI code page number as an encoding label.
 *
 * 1252 is the fallback for anything unrecognised, matching what `eml.ts` does
 * with an undeclared charset and for the same reason.
 */
function codepageLabel(codepage: number | null): string {
  if (codepage === null || codepage <= 0) return "windows-1252";
  if (codepage === 65001) return "utf-8";
  if (codepage === 1200) return "utf-16le";
  if (codepage === 20127) return "us-ascii";
  if (codepage >= 28591 && codepage <= 28606) return `iso-8859-${codepage - 28590}`;
  return `windows-${codepage}`;
}

/* -------------------------------------------------------------- reading -- */

export function parseMsg(bytes: Uint8Array): EmlMessage {
  const problems: string[] = [];
  const root = readCompoundFile(bytes).root;
  const props = new Properties(root, 32);

  // The original header block, where the message still carries it. Everything
  // below prefers it: it is what the message actually travelled with.
  const headers = parseHeaders(props.str(TAG.transportHeaders, problems));
  const header = (name: string) => headerValue(headers, name);

  const messageClass = props.str(TAG.messageClass).toLowerCase();
  const signed = messageClass.includes("smime.multipartsigned");
  const encrypted = messageClass === "ipm.note.smime";

  if (signed) {
    problems.push(
      "This message is signed. The signature was not checked — the text below is what the file contains, not something this plugin has verified.",
    );
  }
  if (encrypted) {
    problems.push(
      "This message is encrypted, so only its headers could be read. The body and any attachments stay in Outlook.",
    );
  }

  const from = senderOf(props, header("from"), problems);
  const recipients = readRecipients(root, problems);
  const body = readBody(props, problems);

  const subject =
    props.str(TAG.subject, problems).trim() ||
    props.str(TAG.normalizedSubject, problems).trim() ||
    props.str(TAG.conversationTopic, problems).trim() ||
    header("subject").trim();

  const date =
    parseMailDate(header("date")) ??
    props.time(TAG.clientSubmitTime) ??
    props.time(TAG.deliveryTime) ??
    props.time(TAG.lastModified);

  const realId =
    stripAngles(header("message-id")) || stripAngles(props.str(TAG.internetMessageId));
  const messageId = realId || syntheticId(subject, date, from, body.text);
  const inReplyTo =
    stripAngles(header("in-reply-to")) || stripAngles(props.str(TAG.inReplyToId));

  const message: EmlMessage = {
    messageId,
    inReplyTo,
    references: referencesOf(header("references"), props, inReplyTo, realId !== ""),
    subject,
    date,
    from,
    to: recipients.to.length > 0 ? recipients.to : parseAddressList(header("to")),
    cc: recipients.cc.length > 0 ? recipients.cc : parseAddressList(header("cc")),
    replyTo: parseAddressList(header("reply-to")),
    body: body.text,
    bodyFromHtml: body.fromHtml,
    attachments: readAttachments(root, problems),
    signed,
    encrypted,
    format: "msg",
    problems,
  };

  if (message.date === null) {
    problems.push("No readable date in this file.");
  }

  return message;
}

/* ------------------------------------------------------------ addresses -- */

/**
 * Who sent it.
 *
 * Four sources in descending order of trustworthiness, and the reason there are
 * four is Exchange: internally, `PidTagSenderEmailAddress` holds an X.500
 * distinguished name — `/o=ExchangeLabs/ou=…/cn=…` — not a mailbox, so the
 * SMTP-specific properties have to be tried first.
 *
 * When none of them yields an address, the sender is recorded by display name
 * with **no address at all** rather than an invented one. That matters: the
 * caller decides direction by matching the sender against the user's own
 * mailboxes, and a fabricated address would quietly answer a question the file
 * cannot answer. A problem is raised instead, which the review dialog shows.
 */
function senderOf(props: Properties, fromHeader: string, problems: string[]): EmlAddress[] {
  const fromHeaders = parseAddressList(fromHeader);
  if (fromHeaders.length > 0) return fromHeaders;

  const name =
    props.str(TAG.senderName).trim() || props.str(TAG.sentRepresentingName).trim();

  const candidates = [
    props.str(TAG.senderSmtpAddress),
    props.str(TAG.sentRepresentingSmtpAddress),
    smtpOnly(props.str(TAG.senderAddress), props.str(TAG.senderAddressType)),
    smtpOnly(props.str(TAG.sentRepresentingAddress), props.str(TAG.senderAddressType)),
  ];

  const address = candidates.map((value) => value.trim()).find((value) => value.includes("@"));

  if (address === undefined) {
    problems.push(
      name === ""
        ? "This file names no sender, so which way the message went cannot be told from it."
        : `The only sender recorded is the Exchange directory entry for ${name}, not an email address, so which way the message went cannot be told from it.`,
    );
    return [];
  }

  return [{ name: name.toLowerCase() === address.toLowerCase() ? "" : name, address, key: address.toLowerCase() }];
}

/** An address is only usable when the address type says it is an SMTP one. */
function smtpOnly(address: string, type: string): string {
  return type.trim().toUpperCase() === "EX" ? "" : address;
}

function readRecipients(
  root: CfbEntry,
  problems: string[],
): { to: EmlAddress[]; cc: EmlAddress[] } {
  const to: EmlAddress[] = [];
  const cc: EmlAddress[] = [];

  for (const child of root.children) {
    if (child.kind !== "storage" || !child.name.startsWith(RECIPIENT_PREFIX)) continue;

    const props = new Properties(child, 8);
    const address =
      props.str(TAG.smtpAddress).trim() ||
      smtpOnly(props.str(TAG.emailAddress), props.str(TAG.addressType)).trim();
    if (!address.includes("@")) continue;

    const name = props.str(TAG.displayName, problems).trim();
    const entry: EmlAddress = {
      name: name.toLowerCase() === address.toLowerCase() ? "" : name,
      address,
      key: address.toLowerCase(),
    };

    const kind = props.int(TAG.recipientType);
    // Blind copies are deliberately dropped. A Bcc list is visible only in the
    // sender's own copy, and writing it into a shared thread note discloses
    // something the recipients were never shown.
    if (kind === RECIPIENT_BCC) continue;
    if (kind === RECIPIENT_CC) cc.push(entry);
    else if (kind === RECIPIENT_TO || kind === null) to.push(entry);
  }

  return { to: dedupe(to), cc: dedupe(cc.filter((entry) => !to.some((o) => o.key === entry.key))) };
}

function dedupe(addresses: readonly EmlAddress[]): EmlAddress[] {
  const seen = new Set<string>();
  return addresses.filter((address) => !seen.has(address.key) && seen.add(address.key));
}

/* ----------------------------------------------------------------- body -- */

/**
 * The readable body, in the same order of preference as the `.eml` path.
 *
 * The third case is the one that earns this module its RTF dependency: plenty
 * of internal Outlook mail has neither a plain-text nor an HTML property, only
 * a compressed RTF one. Skipping it would import those conversations with no
 * text at all.
 */
function readBody(props: Properties, problems: string[]): { text: string; fromHtml: boolean } {
  const plain = props.str(TAG.body, problems);
  if (plain.trim() !== "") return { text: plain.replace(/\r\n/g, "\n").trim(), fromHtml: false };

  const html = props.bin(TAG.html);
  if (html !== null && html.length > 0) {
    return { text: htmlToText(decodeText(html, sniffCharset(html, props.charset()), problems)), fromHtml: true };
  }

  const rtf = props.bin(TAG.rtfCompressed);
  if (rtf !== null && rtf.length > 0) {
    try {
      const body = readRtf(decompressRtf(rtf), problems);
      return { text: body.text, fromHtml: body.fromHtml };
    } catch (error) {
      problems.push(
        `The message body is stored as compressed RTF that could not be read (${error instanceof Error ? error.message : "unknown error"}).`,
      );
    }
  }

  return { text: "", fromHtml: false };
}

/**
 * Prefer the charset the HTML declares over the one MAPI declares.
 *
 * `PidTagHtml` is raw bytes and the two do disagree — Outlook records the store
 * code page while the markup carries a UTF-8 `<meta charset>`. The markup is
 * the one whose author chose the encoding of the bytes that follow it.
 */
function sniffCharset(html: Uint8Array, fallback: string): string {
  let head = "";
  for (let i = 0; i < Math.min(html.length, 2048); i++) head += String.fromCharCode(html[i]!);

  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head) ??
    /\bcharset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head);
  return meta?.[1] ?? fallback;
}

/* ---------------------------------------------------------- attachments -- */

function readAttachments(root: CfbEntry, problems: string[]): EmlAttachment[] {
  const attachments: EmlAttachment[] = [];

  for (const child of root.children) {
    if (child.kind !== "storage" || !child.name.startsWith(ATTACHMENT_PREFIX)) continue;

    const props = new Properties(child, 8);
    const name =
      props.str(TAG.attachLongFilename, problems).trim() ||
      props.str(TAG.attachFilename, problems).trim() ||
      props.str(TAG.displayName, problems).trim();

    if (props.int(TAG.attachMethod) === ATTACH_EMBEDDED_MESSAGE) {
      // An attached message is a whole nested `.msg` storage, not a file. It
      // could be unpacked, but it would then be a message with no thread of its
      // own; naming it is honest and leaves the original in Outlook.
      problems.push(
        `An email attached to this message${name === "" ? "" : ` ("${name}")`} was left in Outlook — attached messages are not imported.`,
      );
      continue;
    }

    const data = props.bin(TAG.attachData);
    if (data === null) {
      if (name !== "") {
        problems.push(`The attachment "${name}" has no readable content in this file.`);
      }
      continue;
    }

    const contentId = props.str(TAG.attachContentId).trim();
    attachments.push({
      filename: name === "" ? `attachment${props.str(TAG.attachExtension).trim()}` : name,
      mimeType: props.str(TAG.attachMimeTag).trim().toLowerCase() || "application/octet-stream",
      bytes: data,
      // Hidden plus a content id is how Outlook marks the images referenced
      // from an HTML body — a signature logo, usually.
      inline: contentId !== "" || props.bool(TAG.attachHidden) === true,
      contentId,
    });
  }

  return attachments;
}

/* ------------------------------------------------------------- identity -- */

/** A conversation index is this header plus one 5-byte response level per reply. */
const CONVERSATION_HEADER = 22;

/**
 * The conversation chain.
 *
 * The real `References` header first, then MAPI's own copy of it. Failing both,
 * the conversation index: its first 22 bytes hold a GUID that every message in
 * an Exchange conversation shares, which is the only thread identity an
 * internal message that never crossed the internet has.
 *
 * That token is written as `msg-conv:…`, deliberately not shaped like a message
 * id. It groups `.msg` files with each other; it cannot match an `.eml`, and it
 * is not pretending to.
 *
 * **Which is exactly why it is a last resort.** Found against a real Outlook
 * file: a newsletter carries a perfectly good `Message-ID` and no `References`,
 * because it opened its own thread — and letting the Exchange token stand in
 * as the root there would key the thread on a GUID no `.eml` can ever match,
 * splitting one conversation in two by which format it happened to be saved
 * in. So the token is used only when the file offers nothing internet-shaped:
 * no `References`, no `In-Reply-To`, and no real id of its own to be the root
 * with.
 */
function referencesOf(
  headerValue: string,
  props: Properties,
  inReplyTo: string,
  hasRealId: boolean,
): string[] {
  const fromHeader = parseReferences(headerValue);
  if (fromHeader.length > 0) return fromHeader;

  const mapi = parseReferences(props.str(TAG.internetReferences));
  if (mapi.length > 0) return mapi;

  // The parent's id is internet-shaped, so an `.eml` in the same conversation
  // can agree with it; `threadKeyOf` falls through to it on its own.
  if (inReplyTo !== "") return [];

  const index = props.bin(TAG.conversationIndex);
  if (index === null || index.length < CONVERSATION_HEADER) return [];

  // Exactly the header and no response level means this message opened the
  // conversation, so its own id — if it has a real one — is the root.
  if (index.length === CONVERSATION_HEADER && hasRealId) return [];

  return [`msg-conv:${hex(index.subarray(6, CONVERSATION_HEADER))}`];
}

/**
 * An identity for a message that carries none.
 *
 * Drafts and some internal items have no `Message-ID` at all, and without one
 * every re-import would append the same message again. This derives a stable
 * one from what the message *is*, so importing the same file twice recognises
 * it the second time.
 *
 * Prefixed `msg-local:` so nobody reading the note mistakes it for something
 * the mail system issued. FNV-1a is used because this is a dedupe key, not a
 * security boundary — there is nothing here for a collision to gain.
 */
function syntheticId(
  subject: string,
  date: number | null,
  from: readonly EmlAddress[],
  body: string,
): string {
  // A separator no field can contain, so two different splittings of the
  // same text cannot produce the same seed.
  const seed = [
    subject,
    String(date ?? 0),
    from.map((a) => a.key).join(","),
    String(body.length),
    body.slice(0, 512),
  ].join("\u0000");

  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  let second = 0x1000193;
  for (let i = seed.length - 1; i >= 0; i--) {
    second ^= seed.charCodeAt(i) & 0xff;
    second = Math.imul(second, 0x811c9dc5) >>> 0;
  }

  return `msg-local:${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
