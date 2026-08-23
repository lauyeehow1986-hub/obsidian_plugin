/**
 * The rules that decide *which notes* (§7 B4).
 *
 * Stages, durations, date windows, the phrases that stand for a whole filter,
 * people and studies, note types, and negation. Each returns a chip carrying a
 * plain-English label, because the label is what a reader checks the query
 * against — see the note on auditability in `chips.ts`.
 *
 * `shaping.ts` holds the other half: grouping, totals, sorting and limits.
 *
 * Pure module: no Obsidian, no Node.
 */

import { FILLER, GLUE, NAME_FIELDS, NEGATORS } from "./phrases";
import { condition, type FilterNode, type Operator } from "./model";
import { dateOperand, durationOperand, parseQuantity } from "./words";
import { kindOf, labelOf, skipWhile, word, type Rule, type Scan } from "./scan";
import type { DateWindow } from "./context";

/**
 * A duration comparison: `[anchor] [glue] <comparator> <quantity>`.
 *
 * The anchor decides *which* duration, and it may be pending from earlier in
 * the sentence — "stuck in approval … more than 2 weeks" is about the current
 * stage even though the words are five apart. With no anchor at all it falls
 * back to time-in-stage, and the chip says so, because §5.1 insists current
 * dwell and cumulative age are different numbers.
 */
export const ruleDuration: Rule = (scan, at) => {
  let index = at;
  let field: string | null = null;
  let op: Operator | null = null;

  const anchor = scan.ctx.durationAnchors.match(scan.tokens, index);
  if (anchor) {
    field = anchor.value.field;
    op = anchor.value.op ?? null;
    index += anchor.length;
  }

  index = skipWhile(scan, index, (norm) => GLUE.has(norm));
  const comparator = scan.ctx.comparators.match(scan.tokens, index);
  if (comparator) {
    op = comparator.value;
    index += comparator.length;
  }
  index = skipWhile(scan, index, (norm) => GLUE.has(norm) || norm === "the");

  const quantity = parseQuantity(scan.tokens, index);
  if (quantity === null || op === null) return null;
  index += quantity.length;

  const chosen = field ?? scan.duration ?? (scan.ctx.fields.has("dwell") ? "dwell" : "age");
  const kind = kindOf(scan, chosen);
  if (kind !== "duration" && kind !== "number") return null;

  // `unreconciled_days` and friends count days as a plain number; `dwell` and
  // `age` are milliseconds and take the `14d` operand `evaluate.ts` reads.
  const value = kind === "duration" ? durationOperand(quantity.days) : quantity.days;
  const wording = op === "gt" || op === "gte" ? "more than" : "less than";
  return {
    length: index - at,
    bodies: [
      {
        kind: "filter",
        label: `${labelOf(scan, chosen)} ${wording} ${quantity.text}`,
        node: condition(chosen, op, value),
      },
    ],
  };
};

function isoDateAt(scan: Scan, at: number): { value: string; length: number } | null {
  const token = scan.tokens[at];
  if (token === undefined) return null;
  const candidate = scan.text.slice(token.start, token.start + 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? { value: candidate, length: 3 } : null;
}

/**
 * A date window: `[field] [before|since|…] (named window | last/next N units | ISO date)`.
 *
 * With an explicit comparator the window's **start** is the boundary — "before
 * next week" means before it begins — and the chip names the offset it
 * resolved to, so nobody has to hold a definition of "this week" in their head.
 * Offsets rather than dates are stored, so a saved view keeps meaning (§5.14).
 */
export const ruleDateWindow: Rule = (scan, at) => {
  let index = at;
  let field: string | null = null;

  const anchor = scan.ctx.dateAnchors.match(scan.tokens, index);
  if (anchor) {
    field = anchor.value;
    index += anchor.length;
  }
  index = skipWhile(scan, index, (norm) => ["in", "on", "the", "at", "during"].includes(norm));

  const comparator = scan.ctx.dateComparators.match(scan.tokens, index);
  if (comparator) index += comparator.length;
  index = skipWhile(scan, index, (norm) => ["the"].includes(norm));

  let window: DateWindow | null = null;
  let literal: string | null = null;

  const named = scan.ctx.windows.match(scan.tokens, index);
  const direction = word(scan, index);
  const iso = isoDateAt(scan, index);
  if (named) {
    window = named.value;
    index += named.length;
  } else if (direction === "next" || direction === "last" || direction === "past") {
    const quantity = parseQuantity(scan.tokens, index + 1);
    if (quantity === null) return null;
    window =
      direction === "next"
        ? { from: 0, to: quantity.days, label: `within ${quantity.text}` }
        : { from: -quantity.days, to: 0, label: `in the last ${quantity.text}` };
    index += 1 + quantity.length;
  } else if (iso) {
    literal = iso.value;
    index += iso.length;
  } else {
    return null;
  }

  const chosen = field ?? scan.date;
  if (chosen === null || kindOf(scan, chosen) !== "date") return null;

  if (comparator) {
    const boundary = literal ?? dateOperand(window?.from ?? 0);
    const wording: Record<string, string> = { lt: "before", lte: "by", gt: "after", gte: "from" };
    return {
      length: index - at,
      bodies: [
        {
          kind: "filter",
          label: `${labelOf(scan, chosen)} ${wording[comparator.value] ?? comparator.value} ${boundary}`,
          node: condition(chosen, comparator.value, boundary),
        },
      ],
    };
  }

  if (literal !== null) {
    return {
      length: index - at,
      bodies: [
        {
          kind: "filter",
          label: `${labelOf(scan, chosen)} is ${literal}`,
          node: condition(chosen, "is", literal),
        },
      ],
    };
  }
  if (window === null) return null;

  const node =
    window.from === window.to
      ? condition(chosen, "is", dateOperand(window.from))
      : condition(chosen, "between", [dateOperand(window.from), dateOperand(window.to)]);
  return {
    length: index - at,
    bodies: [{ kind: "filter", label: `${labelOf(scan, chosen)} ${window.label}`, node }],
  };
};

export const ruleStatus: Rule = (scan, at) => {
  const hit = scan.ctx.statuses.match(scan.tokens, at);
  if (!hit) return null;
  if (!hit.value.fields.every((field) => scan.ctx.fields.has(field))) return null;
  return {
    length: hit.length,
    bodies: [{ kind: "filter", label: hit.value.label, node: hit.value.node }],
  };
};

const STAGE_LEADS = [
  ["stuck", "in"],
  ["stuck", "at"],
  ["sitting", "in"],
  ["sitting", "at"],
  ["waiting", "in"],
  ["waiting", "at"],
  ["in", "stage"],
  ["in"],
  ["at"],
];

export const ruleStage: Rule = (scan, at) => {
  if (!scan.ctx.fields.has("stage")) return null;

  const attempt = (start: number): { stage: { id: string; label: string }; length: number } | null => {
    const hit = scan.ctx.stages.match(scan.tokens, start);
    return hit === null ? null : { stage: hit.value, length: start - at + hit.length };
  };

  let found = attempt(at);
  let led = false;
  if (found === null) {
    for (const lead of STAGE_LEADS) {
      if (!lead.every((expected, offset) => word(scan, at + offset) === expected)) continue;
      found = attempt(at + lead.length);
      if (found !== null) {
        led = true;
        break;
      }
    }
  }
  if (found === null) return null;

  return {
    length: found.length,
    // "in triage for three days" is about time in *that* stage, so a lead-in
    // word arms the dwell anchor for whatever quantity follows.
    ...(led ? { duration: "dwell" } : {}),
    bodies: [
      {
        kind: "filter",
        label: `stage is ${found.stage.label}`,
        node: condition("stage", "is", found.stage.id),
      },
    ],
  };
};

export const ruleType: Rule = (scan, at) => {
  const hit = scan.ctx.types.match(scan.tokens, at);
  if (!hit) return null;
  return { length: hit.length, bodies: [{ kind: "type", label: hit.value, types: [hit.value] }] };
};

/**
 * A person, a study, anything with a name: `[preposition] <name>`.
 *
 * The preposition decides the field when it names one — "waiting on Dr Tan" is
 * `blocked_on`, and that is the holdup question §5.1 is built around. Without
 * one, the name is looked for wherever it actually appears, which is why an
 * unrecognised name matches nothing at all rather than being typed into a
 * `contains` and quietly returning zero rows.
 */
export const ruleValue: Rule = (scan, at) => {
  const binding = scan.ctx.bindings.match(scan.tokens, at);
  const start = at + (binding?.length ?? 0);
  const hit = scan.ctx.values.match(scan.tokens, start);
  if (hit === null) return null;

  const bound = binding?.value ?? "";
  const explicit = bound !== "" && scan.ctx.fields.has(bound);
  // Ordered by what the question usually means — who the holdup is first —
  // so the same sentence builds the same query whatever order the index
  // happened to hand the fields over in.
  const rank = (field: string): number => {
    const at = NAME_FIELDS.indexOf(field);
    return at === -1 ? NAME_FIELDS.length : at;
  };
  const fields = explicit
    ? [bound]
    : hit.value.fields.filter((field) => scan.ctx.fields.has(field)).sort((a, b) => rank(a) - rank(b));
  if (fields.length === 0) return null;

  const clauses = fields.map((field) => condition(field, "is", hit.value.value));
  const first = clauses[0];
  if (first === undefined) return null;
  const node: FilterNode =
    clauses.length === 1 ? first : { kind: "group", combine: "or", negate: false, clauses };
  const where = fields.map((field) => labelOf(scan, field)).join(" or ");

  return {
    length: start - at + hit.length,
    bodies: [{ kind: "filter", label: `${where} is ${hit.value.value}`, node }],
  };
};

export const ruleNegator: Rule = (scan, at) =>
  NEGATORS.has(word(scan, at)) ? { length: 1, bodies: [], negate: true } : null;

/**
 * A bare anchor arms the state and says nothing: "due" in "due next week" is
 * consumed by the date rule, but "the due date" on its own should not be
 * reported as gibberish.
 */
export const ruleAnchor: Rule = (scan, at) => {
  const date = scan.ctx.dateAnchors.match(scan.tokens, at);
  if (date && kindOf(scan, date.value) === "date") {
    return { length: date.length, bodies: [], date: date.value };
  }
  const duration = scan.ctx.durationAnchors.match(scan.tokens, at);
  if (duration && scan.ctx.fields.has(duration.value.field)) {
    return { length: duration.length, bodies: [], duration: duration.value.field };
  }
  return null;
};

export const ruleFiller: Rule = (scan, at) => (FILLER.has(word(scan, at)) ? { length: 1, bodies: [] } : null);
