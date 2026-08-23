/**
 * The rules that decide *how the answer is shaped* (§7 B4).
 *
 * Totals, grouping, sorting and a row limit — the half of the query model that
 * is not a filter. "median dwell by stage" is the question §5.1 asks about
 * bottlenecks, and it is one phrase here rather than four clicks in the panels.
 *
 * Pure module: no Obsidian, no Node.
 */

import { type SortSpec } from "./model";
import { parseCount } from "./words";
import { labelOf, matchField, skipWhile, word, type Rule } from "./scan";

/* ------------------------------------------------------------- the rules -- */

export const ruleLimit: Rule = (scan, at) => {
  if (!["top", "first", "limit"].includes(word(scan, at))) return null;
  const count = parseCount(scan.tokens, at + 1);
  if (count === null || count.count < 1) return null;
  return {
    length: 1 + count.length,
    bodies: [{ kind: "limit", label: `first ${count.count}`, limit: count.count }],
  };
};

export const ruleAggregate: Rule = (scan, at) => {
  const fn = scan.ctx.aggregates.match(scan.tokens, at);
  if (!fn) return null;
  let index = at + fn.length;
  index = skipWhile(scan, index, (norm) => ["of", "the"].includes(norm));

  const field = matchField(scan, index);
  if (field === null) {
    if (fn.value !== "count") return null;
    return { length: fn.length, bodies: [{ kind: "aggregate", label: "count", aggregate: { fn: "count" } }] };
  }
  index += field.length;
  return {
    length: index - at,
    bodies: [
      {
        kind: "aggregate",
        label: `${fn.value} of ${labelOf(scan, field.field)}`,
        aggregate: { fn: fn.value, field: field.field },
      },
    ],
  };
};

const GROUP_LEADS = [
  ["grouped", "by"],
  ["group", "by"],
  ["broken", "down", "by"],
  ["split", "by"],
  ["per"],
  ["by"],
];

export const ruleGroup: Rule = (scan, at) => {
  for (const lead of GROUP_LEADS) {
    if (!lead.every((expected, offset) => word(scan, at + offset) === expected)) continue;
    const field = matchField(scan, at + lead.length);
    if (field === null) continue;
    return {
      length: lead.length + field.length,
      bodies: [
        {
          kind: "group",
          label: `grouped by ${labelOf(scan, field.field)}`,
          group: { field: field.field, direction: "asc" },
        },
      ],
    };
  }
  return null;
};

const SORT_LEADS = [
  ["sorted", "by"],
  ["sort", "by"],
  ["ordered", "by"],
  ["order", "by"],
];

const DESCENDING = new Set(["descending", "desc", "down"]);

export const ruleSort: Rule = (scan, at) => {
  const named = scan.ctx.sorts.match(scan.tokens, at);
  if (named && scan.ctx.fields.has(named.value.field)) {
    return {
      length: named.length,
      bodies: [
        {
          kind: "sort",
          label: named.value.label,
          sort: { field: named.value.field, direction: named.value.direction },
        },
      ],
    };
  }

  for (const lead of SORT_LEADS) {
    if (!lead.every((expected, offset) => word(scan, at + offset) === expected)) continue;
    const field = matchField(scan, at + lead.length);
    if (field === null) continue;
    let index = at + lead.length + field.length;
    let direction: SortSpec["direction"] = "asc";
    if (DESCENDING.has(word(scan, index))) {
      direction = "desc";
      index += 1;
    } else if (["ascending", "asc", "up"].includes(word(scan, index))) {
      index += 1;
    }
    return {
      length: index - at,
      bodies: [
        {
          kind: "sort",
          label: `sorted by ${labelOf(scan, field.field)}${direction === "desc" ? ", highest first" : ""}`,
          sort: { field: field.field, direction },
        },
      ],
    };
  }
  return null;
};
