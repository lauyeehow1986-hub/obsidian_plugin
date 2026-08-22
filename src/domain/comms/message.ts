/**
 * Composing the chase-up (CLAUDE.md §7 B1, §5.11).
 *
 * An agenda rendered into something you could actually send. The template lives
 * in `_config/messages/` so the tone and the signature are the user's, not
 * mine — a chase-up in someone else's voice is one people can tell was
 * generated, which is the fastest way to make a governance instrument look
 * like spam.
 *
 * **§5.11 rule 5 is enforced here, by construction.** Protocol URIs pass
 * through the OS shell and can surface in system logs, so a composed body may
 * carry request ids, dates and stage names — and nothing else. The way that is
 * guaranteed is not a filter over free text but a **closed set of substitution
 * variables**: a template can only interpolate what `messageFields` offers, and
 * what it offers is that list. There is deliberately no `{{body}}`,
 * `{{note}}`, `{{patient}}` or `{{summary_of_the_data}}`, so no template — not
 * one the user writes, not one pasted from elsewhere — can reach clinical
 * content.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate } from "../time/dates";
import type { Agenda, AgendaItem } from "./agenda";
import { summariseAgenda } from "./agenda";

/**
 * Every variable a template may use. This list *is* the §5.11 rule 5 guarantee.
 *
 * Adding one is a governance decision: it widens what can leave the machine in
 * a URI. Anything derived from note prose or from clinical fields does not
 * belong here at any size.
 */
export const MESSAGE_FIELDS = [
  "name",
  "date",
  "count",
  "summary",
  "items",
  "actor",
] as const;
export type MessageField = (typeof MESSAGE_FIELDS)[number];

export interface MessageTemplate {
  /** Filename stem in `_config/messages/`, used to pick one. */
  id: string;
  subject: string;
  body: string;
}

/**
 * The built-in chase-up, used when `_config/messages/` has nothing in it.
 *
 * Written to be sendable unedited but obviously editable: no apology, no
 * deadline invented on the user's behalf, and an explicit offer to be told the
 * item is not theirs — because sometimes `blocked_on` is simply wrong, and a
 * message that leaves no room for that generates an awkward reply.
 */
export const DEFAULT_CHASE_TEMPLATE: MessageTemplate = {
  id: "chase-up",
  subject: "Outstanding items — {{count}}",
  body: [
    "Dear {{name}},",
    "",
    "A short summary of what is currently with you ({{summary}}):",
    "",
    "{{items}}",
    "",
    "If any of these have moved on, or are not actually with you, do let me know",
    "and I will correct our records.",
    "",
    "Many thanks,",
    "{{actor}}",
  ].join("\n"),
};

/** How one agenda item reads inside a message. Ids, dates and stages only. */
export function itemLine(item: AgendaItem): string {
  const title = item.title.trim();
  return `- ${item.link}${title === "" ? "" : ` — ${title}`}: ${item.ask} ${item.context}`.trimEnd();
}

export interface MessageContext {
  agenda: Agenda;
  now: number;
  actor: string;
  /** Cap on how many items are listed. The rest are counted, never dropped silently. */
  maxItems?: number;
}

/**
 * The values a template may interpolate. Nothing outside this record can reach
 * a URI, which is the point.
 */
export function messageFields(context: MessageContext): Record<MessageField, string> {
  const max = context.maxItems ?? 12;
  const shown = context.agenda.items.slice(0, max);
  const hidden = context.agenda.items.length - shown.length;

  const lines = shown.map(itemLine);
  if (hidden > 0) {
    // Named rather than truncated silently: the recipient needs to know the
    // list is longer than what they can see.
    lines.push(`- …and ${hidden} more, listed in full when we meet.`);
  }

  return {
    name: context.agenda.party.name,
    date: toVaultDate(context.now),
    count: String(context.agenda.items.length),
    summary: summariseAgenda(context.agenda),
    items: lines.join("\n"),
    actor: context.actor,
  };
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/**
 * Fill a template.
 *
 * An unknown placeholder is left **exactly as written** rather than replaced
 * with an empty string. A template that says `{{deadline}}` has a mistake in
 * it, and a draft that silently reads "please reply by ." is worse than one
 * that visibly reads "please reply by {{deadline}}" — the second gets fixed.
 */
export function fillTemplate(
  template: string,
  fields: Record<string, string>,
): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = template.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name]!;
    if (!unknown.includes(name)) unknown.push(name);
    return whole;
  });
  return { text, unknown };
}

export interface ComposedDraft {
  subject: string;
  body: string;
  /** Placeholders the template used that do not exist. Shown, never swallowed. */
  unknown: string[];
}

/** Render a template against an agenda. */
export function composeMessage(
  template: MessageTemplate,
  context: MessageContext,
): ComposedDraft {
  const fields = messageFields(context);
  const subject = fillTemplate(template.subject, fields);
  const body = fillTemplate(template.body, fields);
  return {
    subject: subject.text,
    body: body.text,
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
  };
}

/**
 * A one-line summary for the thread's message log.
 *
 * Deliberately not the body. §5.10 stores a summary; a thread note is read back
 * into briefings and exports, and a message body in there is content that would
 * travel with them.
 */
export function draftSummary(agenda: Agenda): string {
  return agenda.items.length === 0
    ? "Chased up (nothing open)"
    : `Chased ${summariseAgenda(agenda)}`;
}

/** Parse a template note's frontmatter into a template. Missing parts fall back. */
export function readTemplate(
  id: string,
  frontmatter: Record<string, unknown>,
  body: string,
): MessageTemplate {
  const subject = frontmatter["subject"];
  return {
    id,
    subject:
      typeof subject === "string" && subject.trim() !== ""
        ? subject.trim()
        : DEFAULT_CHASE_TEMPLATE.subject,
    body: body.trim() === "" ? DEFAULT_CHASE_TEMPLATE.body : body.trim(),
  };
}
