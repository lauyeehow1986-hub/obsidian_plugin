/**
 * Turning minutes into actions, decisions and deadlines (CLAUDE.md §7 B6).
 *
 * Minutes are where work goes to die: the note is written, the meeting ends,
 * and three actions sit in a paragraph nobody reopens. This module reads them
 * back out — **rules and regex only**, as B6 requires, so the same note always
 * yields the same items and a wrong reading can be traced to a line of code
 * rather than to a model's mood.
 *
 * What it will not do:
 *
 *  - **It never writes a wikilink to a person the vault does not already
 *    know.** `[[Dr Tan]]` created beside an existing `[[Dr A Tan]]` splits one
 *    clinician into two, and the holdup view — whose entire value is grouping
 *    everything one person is sitting on — quietly shows half of it. An
 *    unrecognised name is carried as plain text and flagged.
 *  - **It never resolves an ambiguous name.** Two people whose surname is Tan
 *    means no owner and a stated reason, not a coin toss.
 *  - **It never acts.** `scanMinutes` returns candidates. Every one is shown,
 *    editable and tickable before anything reaches the vault — minutes are
 *    untrusted text under §2 rule 5 exactly as a policy circular is.
 *
 * Pure module: no Obsidian, no Node.
 */

import { sha256 } from "../audit/sha256";
import { parseParty } from "../comms/party";
import { readWhen, type DueDate } from "./when";

export const ITEM_KINDS = ["action", "decision", "deadline"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Something noticed but not resolved.
 *
 * Tagged with what it is about, so a caller can drop the ones the user has
 * since answered. A warning that "no deadline was set" sitting beside a date
 * field the user has just filled in is worse than no warning: it makes the
 * reader distrust the field or the message, and they cannot tell which.
 */
export interface Problem {
  about: "owner" | "due";
  message: string;
}

export interface Owner {
  /** Written into notes exactly as this: a wikilink when the vault knows them. */
  ref: string;
  /** The bare name, for display. */
  name: string;
  /** The vault has a person by this name. False means the reference stays plain text. */
  known: boolean;
}

export interface ExtractedItem {
  kind: ItemKind;
  /**
   * 1-based line **within the body**, not within the file.
   *
   * Deliberately not the file line. Extraction writes its manifest into the
   * meeting note's frontmatter, so a file-relative number frozen onto a
   * created note is wrong the moment the run that created it finishes — eight
   * items add roughly fifty lines above the prose. Counting from the end of
   * the frontmatter makes the reference immune to our own writes. It still
   * drifts if the minutes themselves are edited above the line, which nothing
   * short of storing the whole text could survive.
   */
  line: number;
  /** The line exactly as written. */
  raw: string;
  /** The line with its marker, owner clause and date clause lifted out. */
  text: string;
  owner: Owner | null;
  due: DueDate | null;
  /**
   * Identity for dedupe, from the kind and the words — never the line number.
   * Minutes get edited above the line they came from, and a key that moved
   * with the text would offer every item again.
   */
  key: string;
  problems: Problem[];
}

export interface MinutesScan {
  items: ExtractedItem[];
  /** Ticked checkboxes, counted so the dialog can say they were left alone. */
  done: number;
}

export interface MinutesInput {
  /** The whole file, frontmatter and all. */
  content: string;
  /** The meeting's own date as `YYYY-MM-DD`, or "" when the note does not say. */
  anchor: string;
  /** Every person name the vault knows, for owner resolution. */
  people: readonly string[];
}

/**
 * Marker words, longest first so "action item" wins over "action".
 *
 * `AI:` is deliberately absent. It is a real minutes convention for "action
 * item", and in a research department in 2026 it is far more often the other
 * thing — a marker that fires on "AI: consider a triage model" is worse than
 * one word of coverage lost.
 */
const MARKERS: readonly (readonly [ItemKind, string])[] = [
  ["action", "action item"],
  ["action", "action"],
  ["action", "actions"],
  ["action", "follow-up"],
  ["action", "follow up"],
  ["action", "to-do"],
  ["action", "todo"],
  ["action", "task"],
  ["decision", "decision"],
  ["decision", "decided"],
  ["decision", "agreed"],
  ["decision", "resolved"],
  ["deadline", "deadline"],
  ["deadline", "due date"],
  ["deadline", "due"],
  ["deadline", "milestone"],
];

/** The marker words as the user would need to type them, for the empty state. */
export const MARKER_WORDS: Record<ItemKind, string[]> = {
  action: MARKERS.filter(([kind]) => kind === "action").map(([, word]) => word),
  decision: MARKERS.filter(([kind]) => kind === "decision").map(([, word]) => word),
  deadline: MARKERS.filter(([kind]) => kind === "deadline").map(([, word]) => word),
};

const MARKER_RE = new RegExp(
  `^(${[...MARKERS]
    .map(([, word]) => word)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join("|")})\\s*(?::|[-–—]\\s|\\)\\s)\\s*(.*)$`,
  "i",
);

const KIND_OF = new Map<string, ItemKind>(MARKERS.map(([kind, word]) => [word, kind]));

/** Lines that record that there was nothing to record. */
const NOTHING = /^(?:none|nil|n\/?a|no items?|nothing|-+)\.?$/i;

const HONORIFICS = new Set([
  "dr", "prof", "professor", "assoc", "associate", "a/prof", "adj", "adjunct",
  "asst", "assistant", "mr", "mrs", "ms", "miss", "mx", "sr", "sister",
]);

const WIKILINK = /\[\[[^\]|#^]+(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/;
const HANDLE = /(?:^|\s)@([A-Za-z][A-Za-z.'-]*)/;
const NAME_TO = /^((?:[A-Z][\w.'’-]*)(?:\s+[A-Z][\w.'’-]*){0,3})\s+(?:to|will|is to|shall)\s+/;

function nameWords(name: string): string[] {
  return name
    .split(/\s+/)
    .map((word) => word.replace(/[.,'’]/g, "").toLowerCase())
    .filter((word) => word !== "" && !HONORIFICS.has(word));
}

function initialsOf(name: string): string {
  return nameWords(name)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}

function isSuffix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  return shorter.every((word, index) => word === longer[offset + index]);
}

/**
 * Match a written name against the people the vault knows.
 *
 * Surname-suffix matching is what makes "Tan to countersign" usable — minutes
 * never carry a full name. Exactly one match or nothing: two Tans is a
 * question for the user, not a guess for us.
 */
export function matchPerson(
  written: string,
  people: readonly string[],
): { name: string } | "ambiguous" | null {
  const wanted = nameWords(written);
  if (wanted.length === 0) return null;

  const exact = people.filter((person) => {
    const known = nameWords(person);
    return known.length === wanted.length && isSuffix(wanted, known);
  });
  if (exact.length === 1) return { name: exact[0]! };
  if (exact.length > 1) return "ambiguous";

  const partial = people.filter((person) => isSuffix(wanted, nameWords(person)));
  if (partial.length === 1) return { name: partial[0]! };
  if (partial.length > 1) return "ambiguous";
  return null;
}

/** Match an `@handle` against known people by initials or by surname. */
function matchHandle(handle: string, people: readonly string[]): { name: string } | "ambiguous" | null {
  const wanted = handle.replace(/[.'’-]/g, "").toLowerCase();
  const hits = people.filter((person) => {
    const words = nameWords(person);
    return (
      initialsOf(person).toLowerCase() === wanted ||
      (words.length > 0 && words[words.length - 1] === wanted)
    );
  });
  if (hits.length === 1) return { name: hits[0]! };
  if (hits.length > 1) return "ambiguous";
  return null;
}

interface OwnerRead {
  owner: Owner | null;
  rest: string;
  problems: Problem[];
}

/**
 * Who the line makes responsible.
 *
 * Three forms, in falling order of confidence: a wikilink the user typed
 * themselves, an `@handle`, and the "Tan to chase the DUA" idiom that minutes
 * are actually written in. The idiom is only believed when the name resolves
 * to somebody the vault has heard of — otherwise "Everyone to review" becomes
 * a person called Everyone.
 */
function readOwner(text: string, people: readonly string[]): OwnerRead {
  const problems: Problem[] = [];
  const note = (message: string) => problems.push({ about: "owner", message });
  const known = new Set(people.map((person) => person.toLowerCase()));

  const link = WIKILINK.exec(text);
  if (link) {
    const party = parseParty(link[0]);
    const owner: Owner = {
      // Honour what the user typed. Rewriting their link to a "better" target
      // is exactly the silent renaming this module refuses to do.
      ref: link[0],
      name: party.name,
      known: known.has(party.name.toLowerCase()),
    };
    if (!owner.known) {
      note(`There is no note for ${party.name}; the link will point at nothing until there is.`);
    }
    return { owner, rest: stripLead(text, link.index, link.index + link[0].length), problems };
  }

  const handle = HANDLE.exec(text);
  if (handle) {
    const matched = matchHandle(handle[1]!, people);
    if (matched === "ambiguous") {
      note(`More than one person answers to "@${handle[1]}", so no owner was set.`);
    } else if (matched !== null) {
      const at = text.indexOf(`@${handle[1]}`);
      return {
        owner: { ref: `[[${matched.name}]]`, name: matched.name, known: true },
        rest: stripLead(text, at, at + handle[1]!.length + 1),
        problems,
      };
    } else {
      note(`"@${handle[1]}" does not match anyone in the vault, so no owner was set.`);
    }
  }

  const named = NAME_TO.exec(text);
  if (named) {
    const matched = matchPerson(named[1]!, people);
    if (matched === "ambiguous") {
      note(`More than one person is called "${named[1]}", so no owner was set.`);
    } else if (matched !== null) {
      return {
        owner: { ref: `[[${matched.name}]]`, name: matched.name, known: true },
        rest: text.slice(named[0].length).trim(),
        problems,
      };
    }
  }

  return { owner: null, rest: text, problems };
}

/**
 * Drop an owner reference when it opens the sentence as "X to do the thing",
 * leaving the verb phrase as the title. Anywhere else it is left in place —
 * the sentence needs it to read.
 */
function stripLead(text: string, from: number, to: number): string {
  if (text.slice(0, from).trim() !== "") return text;
  const after = text.slice(to);
  const idiom = /^\s+(?:to|will|is to|shall)\s+/.exec(after);
  return idiom ? after.slice(idiom[0].length).trim() : text;
}

interface Stripped {
  text: string;
  checkbox: "open" | "done" | null;
}

/** Peel off the markdown a line is dressed in, leaving the sentence. */
function strip(line: string): Stripped {
  let text = line.replace(/^\s*(?:>\s*)+/, "").replace(/^\s*#{1,6}\s+/, "");
  text = text.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "");

  let checkbox: "open" | "done" | null = null;
  const box = /^\[([ xX])\]\s*/.exec(text);
  if (box) {
    checkbox = box[1] === " " ? "open" : "done";
    text = text.slice(box[0].length);
  }

  return { text: text.replace(/^[*_]{1,3}/, "").trim(), checkbox };
}

/** Emphasis left behind once the marker inside it has been taken. */
function unemphasise(text: string): string {
  return text.replace(/^[*_]{1,3}\s*/, "").replace(/\s*[*_]{1,3}$/, "").trim();
}

/** The body, with the frontmatter block dropped. Line 1 is the body's first line. */
function bodyOf(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return lines;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") return lines.slice(i + 1);
  }
  return lines;
}

/** The words an item is identified by, insensitive to case and punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function itemKey(kind: ItemKind, text: string): string {
  return sha256(`${kind}\n${normalise(text)}`).slice(0, 12);
}

/** Read every candidate out of a set of minutes. Writes nothing, decides nothing. */
export function scanMinutes(input: MinutesInput): MinutesScan {
  const lines = bodyOf(input.content);
  const anchor = input.anchor.trim() === "" ? null : input.anchor.trim();
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();
  let done = 0;

  lines.forEach((raw, offset) => {
    const stripped = strip(raw);
    if (stripped.text === "") return;

    const marked = MARKER_RE.exec(stripped.text);
    const kind: ItemKind | null = marked
      ? (KIND_OF.get(marked[1]!.toLowerCase()) ?? null)
      : stripped.checkbox === "open"
        ? "action"
        : null;

    if (stripped.checkbox === "done" && marked === null) {
      // Somebody already did it. Counted, never offered: re-creating a note
      // for a ticked box is the fastest way to make this feature untrusted.
      done += 1;
      return;
    }
    if (kind === null) return;
    if (stripped.checkbox === "done") {
      done += 1;
      return;
    }

    const body = unemphasise(marked ? (marked[2] ?? "") : stripped.text);
    if (body === "" || NOTHING.test(body)) return;

    const ownerRead = readOwner(body, input.people);
    const when = readWhen(ownerRead.rest, anchor);
    const text = when.rest === "" ? body : when.rest;
    const key = itemKey(kind, body);

    // The same sentence twice in one set of minutes is a restatement, not two
    // jobs. Keeping the first keeps the line number of where it was decided.
    if (seen.has(key)) return;
    seen.add(key);

    items.push({
      kind,
      line: offset + 1,
      raw: raw.trim(),
      text,
      owner: ownerRead.owner,
      due: when.due,
      key,
      problems: [
        ...ownerRead.problems,
        ...when.problems.map((message): Problem => ({ about: "due", message })),
      ],
    });
  });

  return { items, done };
}
