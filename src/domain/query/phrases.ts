/**
 * The English the search box understands (CLAUDE.md §7 B4).
 *
 * Tables only: which words name a note type, which name a field, which stand
 * for a whole filter. The scanner in `language.ts` reads them; nothing here
 * decides anything.
 *
 * Keeping them here and declarative is the point. B4 promises a parser that is
 * "fully offline, instant, predictable" — predictable means a reader can see
 * the entire vocabulary in one file and check whether a phrase is in it,
 * rather than inferring it from control flow. Anything not in these tables is
 * reported as not understood; the parser never guesses.
 *
 * Pure module: no Obsidian, no Node.
 */

import { andGroup, condition, type FilterNode } from "./model";
import { wordsOf } from "./words";

/* ------------------------------------------------------------------ types -- */

/**
 * How a note type is spoken about.
 *
 * The type string itself always works — an unlisted `type: variable` still
 * answers to "variable" — so this table only exists for the plurals and the
 * words people actually use ("paper" for a publication, "chase" for a thread).
 */
export const TYPE_WORDS: Readonly<Record<string, readonly string[]>> = {
  "scdb-request": ["request", "requests", "edata request", "edata requests", "data request"],
  publication: ["publication", "publications", "paper", "papers", "manuscript", "manuscripts"],
  correspondence: ["thread", "threads", "correspondence", "email", "emails", "message", "messages"],
  obligation: ["obligation", "obligations", "renewal", "renewals"],
  event: ["event", "events", "deadline", "deadlines"],
  person: ["person", "people", "contact", "contacts"],
  capture: ["capture", "captures", "inbox item", "inbox items"],
  "scdb-view": ["saved view", "saved views"],
  "script-doc": ["script", "scripts"],
  variable: ["variable", "variables"],
  run: ["run", "runs"],
  policy: ["policy", "policies"],
};

/* ----------------------------------------------------------------- fields -- */

/**
 * Extra names for a field, beyond its label and its id.
 *
 * Only for fields whose English name is not their label. A word here that also
 * matches another field's label is dropped as ambiguous rather than guessed at
 * — see `fieldAliases` in `language.ts`.
 */
export const FIELD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  dwell: ["dwell", "time in stage", "sitting", "stuck", "waiting"],
  age: ["age", "total age"],
  blocked_for: ["blocked for", "held up for"],
  blocked_on: ["holdup", "blocker", "blocked on", "waiting on"],
  assignee: ["owner"],
  study: ["registry"],
  sla_state: ["sla", "sla state"],
  bounces: ["bounce count", "sent back", "rework"],
  turnaround: ["time to deliver"],
  identifiers: ["identifier scope", "identifiability"],
  irb_ref: ["irb", "dsrb", "ethics"],
  irb_expiry: ["irb expiry", "ethics expiry"],
  effort_estimate_hours: ["estimate", "estimated effort"],
  unreconciled_days: ["days unreconciled", "reconciliation age"],
  received: ["logged", "raised", "opened"],
};

/** Date fields a window can attach to, by the words that name them. */
export const DATE_ANCHORS: readonly { phrase: string; field: string }[] = [
  { phrase: "due", field: "due" },
  { phrase: "deadline", field: "due" },
  { phrase: "received", field: "received" },
  { phrase: "raised", field: "received" },
  { phrase: "logged", field: "received" },
  { phrase: "opened", field: "received" },
  { phrase: "submitted", field: "submitted" },
  { phrase: "blocked since", field: "blocked_since" },
  { phrase: "irb expiry", field: "irb_expiry" },
  { phrase: "ethics expiry", field: "irb_expiry" },
  { phrase: "reconciled", field: "last_reconciled" },
  { phrase: "decision due", field: "decision_due" },
];

/**
 * Duration fields a "more than 2 weeks" can attach to, by the words before it.
 *
 * `stuck in triage for more than 2 weeks` is about the current stage; `older
 * than 2 weeks` is about the whole request. Getting that wrong is the
 * difference between the rework signal and the queue length (§5.1), so the
 * chip always says which one it chose.
 */
export const DURATION_ANCHORS: readonly {
  phrase: string;
  field: string;
  /** A comparative carries its own direction: "older than a week" needs no "more". */
  op?: "gt" | "lt";
}[] = [
  { phrase: "stuck", field: "dwell" },
  { phrase: "sitting", field: "dwell" },
  { phrase: "sat", field: "dwell" },
  { phrase: "in stage", field: "dwell" },
  { phrase: "dwell", field: "dwell" },
  { phrase: "age", field: "age" },
  { phrase: "aged", field: "age" },
  { phrase: "old", field: "age" },
  { phrase: "older", field: "age", op: "gt" },
  { phrase: "younger", field: "age", op: "lt" },
  { phrase: "newer", field: "age", op: "lt" },
  { phrase: "blocked", field: "blocked_for" },
  { phrase: "held up", field: "blocked_for" },
  { phrase: "unreconciled", field: "unreconciled_days" },
  { phrase: "turnaround", field: "turnaround" },
];

/**
 * Words that join an anchor to its quantity and carry no meaning of their own.
 *
 * "stuck in approval **for** more than 2 weeks", "older **than** a fortnight".
 */
export const GLUE: ReadonlySet<string> = new Set(["for", "in", "of", "at", "than", "been", "spent"]);

/** Comparisons that only make sense against a date. */
export const DATE_COMPARATORS: readonly { phrase: string; op: "lt" | "gt" | "gte" | "lte" }[] = [
  { phrase: "before", op: "lt" },
  { phrase: "after", op: "gt" },
  { phrase: "since", op: "gte" },
  { phrase: "until", op: "lte" },
  { phrase: "by", op: "lte" },
];

/**
 * Named windows, as day offsets from the start of today.
 *
 * Rough on purpose and labelled with what they resolved to, so "this week"
 * never quietly means something different from what the reader assumed. A
 * saved view keeps the offsets rather than the dates (§5.14), so it still
 * means the same thing next month.
 */
export const DATE_WINDOWS: readonly { phrase: string; from: number; to: number; label: string }[] = [
  { phrase: "today", from: 0, to: 0, label: "today" },
  { phrase: "tomorrow", from: 1, to: 1, label: "tomorrow" },
  { phrase: "yesterday", from: -1, to: -1, label: "yesterday" },
  { phrase: "this week", from: 0, to: 7, label: "within 7 days" },
  { phrase: "next week", from: 7, to: 14, label: "7 to 14 days from now" },
  { phrase: "last week", from: -7, to: 0, label: "in the last 7 days" },
  { phrase: "this month", from: 0, to: 30, label: "within 30 days" },
  { phrase: "next month", from: 30, to: 60, label: "30 to 60 days from now" },
  { phrase: "last month", from: -30, to: 0, label: "in the last 30 days" },
  { phrase: "this year", from: 0, to: 365, label: "within 365 days" },
  { phrase: "last year", from: -365, to: 0, label: "in the last 365 days" },
];

/** Which way round a comparison runs. */
export const COMPARATORS: readonly { phrase: string; op: "gt" | "lt" | "gte" | "lte" }[] = [
  { phrase: "more than", op: "gt" },
  { phrase: "longer than", op: "gt" },
  { phrase: "greater than", op: "gt" },
  { phrase: "over", op: "gt" },
  { phrase: "above", op: "gt" },
  { phrase: "beyond", op: "gt" },
  { phrase: "past", op: "gt" },
  { phrase: "at least", op: "gte" },
  { phrase: "less than", op: "lt" },
  { phrase: "shorter than", op: "lt" },
  { phrase: "fewer than", op: "lt" },
  { phrase: "under", op: "lt" },
  { phrase: "below", op: "lt" },
  { phrase: "within", op: "lte" },
  { phrase: "at most", op: "lte" },
  { phrase: ">=", op: "gte" },
  { phrase: "<=", op: "lte" },
  { phrase: ">", op: "gt" },
  { phrase: "<", op: "lt" },
];

/**
 * Which field a person's or a study's name binds to, by the word in front.
 *
 * An empty `field` means "wherever that name actually appears in the vault" —
 * decided from the index, not guessed. An explicit preposition always wins,
 * even when the value has never appeared in that field: the user said it.
 */
export const VALUE_BINDINGS: readonly { phrase: string; field: string }[] = [
  { phrase: "waiting on", field: "blocked_on" },
  { phrase: "waiting for", field: "blocked_on" },
  { phrase: "blocked on", field: "blocked_on" },
  { phrase: "blocked by", field: "blocked_on" },
  { phrase: "held up by", field: "blocked_on" },
  { phrase: "stuck with", field: "blocked_on" },
  { phrase: "chasing", field: "blocked_on" },
  { phrase: "with", field: "blocked_on" },
  { phrase: "assigned to", field: "assignee" },
  { phrase: "owned by", field: "assignee" },
  { phrase: "requested by", field: "requester" },
  { phrase: "raised by", field: "requester" },
  { phrase: "asked by", field: "requester" },
  { phrase: "from", field: "requester" },
  { phrase: "for", field: "" },
  { phrase: "about", field: "" },
  { phrase: "on", field: "" },
];

/** The link fields a bare name is looked for in, in preference order. */
export const NAME_FIELDS: readonly string[] = [
  "blocked_on",
  "requester",
  "assignee",
  "study",
  "authors",
  "with",
  "owner",
];

/* --------------------------------------------------------------- statuses -- */

export interface StatusPhrase {
  words: string[];
  label: string;
  node: FilterNode;
  /** Fields the node touches; the phrase is only offered when all are present. */
  fields: string[];
}

function fieldsIn(node: FilterNode): string[] {
  if (node.kind === "condition") return [node.field];
  return node.clauses.flatMap(fieldsIn);
}

function status(phrases: readonly string[], label: string, node: FilterNode): StatusPhrase[] {
  const fields = [...new Set(fieldsIn(node))];
  return phrases.map((phrase) => ({ words: wordsOf(phrase), label, node, fields }));
}

/**
 * Whole filters that have a single English name.
 *
 * These are the ones worth typing: they are the daily questions of §5.1 and
 * §7 B1 — who is stuck, what is late, what is at governance risk — and each
 * expands to exactly the filter the Explore board would have built by hand.
 */
export const STATUS_PHRASES: readonly StatusPhrase[] = [
  ...status(
    ["overdue", "late", "past due"],
    "overdue and not finished",
    andGroup([condition("due", "lt", "today"), condition("completed", "is-false")]),
  ),
  ...status(["breaching", "breached", "sla breached"], "SLA breached", condition("sla_state", "is", "breached")),
  ...status(["at risk"], "SLA at risk", condition("sla_state", "is", "at-risk")),
  ...status(["on track"], "SLA on track", condition("sla_state", "is", "on-track")),
  ...status(
    ["open", "outstanding", "in flight", "live", "unfinished"],
    "not finished",
    condition("completed", "is-false"),
  ),
  ...status(
    ["closed", "done", "finished", "complete", "completed"],
    "finished",
    condition("completed", "is-true"),
  ),
  ...status(["blocked", "held up", "stuck"], "waiting on someone", condition("blocked_on", "not-empty")),
  ...status(["unassigned", "nobody assigned"], "no assignee", condition("assignee", "empty")),
  ...status(["bounced", "sent back"], "bounced at least once", condition("bounces", "gt", 0)),
  ...status(
    ["stranded", "needs migration", "awaiting migration"],
    "quarantined by a workflow change",
    condition("stranded", "is-true"),
  ),
  ...status(
    ["identifiable", "with identifiers"],
    "carries identifiers",
    condition("identifiers", "one-of", ["indirect", "direct"]),
  ),
  ...status(["directly identifiable", "direct identifiers"], "direct identifiers", condition("identifiers", "is", "direct")),
  ...status(
    ["de identified", "deidentified", "anonymous", "no identifiers"],
    "no identifiers",
    condition("identifiers", "is", "none"),
  ),
  ...status(["no irb", "missing irb", "without irb", "no ethics"], "no IRB reference", condition("irb_ref", "empty")),
  ...status(["irb expired", "expired irb", "ethics expired"], "IRB expired", condition("irb_expiry", "lt", "today")),
  ...status(
    ["never reconciled", "unreconciled"],
    "never reconciled against the eData system",
    condition("last_reconciled", "empty"),
  ),
  ...status(["with problems", "broken"], "the plugin could not read something", condition("problem_count", "gt", 0)),
];

/* ----------------------------------------------------------- sort and noise -- */

export const SORT_PHRASES: readonly {
  phrase: string;
  field: string;
  direction: "asc" | "desc";
  label: string;
}[] = [
  { phrase: "longest waiting", field: "dwell", direction: "desc", label: "longest in stage first" },
  { phrase: "longest in stage", field: "dwell", direction: "desc", label: "longest in stage first" },
  { phrase: "oldest first", field: "age", direction: "desc", label: "oldest first" },
  { phrase: "oldest", field: "age", direction: "desc", label: "oldest first" },
  { phrase: "newest first", field: "received", direction: "desc", label: "newest first" },
  { phrase: "newest", field: "received", direction: "desc", label: "newest first" },
  { phrase: "due soonest", field: "due", direction: "asc", label: "soonest due first" },
  { phrase: "soonest", field: "due", direction: "asc", label: "soonest due first" },
  { phrase: "most bounced", field: "bounces", direction: "desc", label: "most bounced first" },
];

/** Words that carry no meaning here and are not worth reporting as unread. */
export const FILLER: ReadonlySet<string> = new Set([
  "show",
  "me",
  "list",
  "find",
  "get",
  "give",
  "please",
  "all",
  "any",
  "every",
  "the",
  "a",
  "an",
  "of",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "that",
  "which",
  "who",
  "what",
  "and",
  "then",
  "still",
  "currently",
  "now",
  "ones",
  "items",
  "notes",
  "has",
  "have",
  "had",
  "there",
  "it",
  "to",
]);

/** Words that flip the next thing understood. */
export const NEGATORS: ReadonlySet<string> = new Set(["not", "except", "excluding", "without", "no"]);
