/**
 * Chips: what the English search understood, and the query it becomes (§7 B4).
 *
 * A chip is one understood phrase plus the characters it came from. That span
 * is what lets the box and the chips stay in step — removing a chip removes
 * exactly its words — and it is what makes the parse auditable rather than
 * magic, which is the whole of B4's "shown as editable chips".
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  andGroup,
  emptyQuery,
  type AggregateSpec,
  type FieldDef,
  type FilterNode,
  type GroupSpec,
  type Query,
  type SortSpec,
} from "./model";

/* ----------------------------------------------------------- vocabulary -- */

export interface Vocabulary {
  /** The field catalogue for the types in play. Nothing outside it is matched. */
  fields: readonly FieldDef[];
  /** Note types present in the vault. */
  types: readonly string[];
  /** Workflow stages, so "in triage" resolves to a stage id. */
  stages: readonly { id: string; label: string }[];
  /** Distinct values per field id — wikilinks already unwrapped — for names. */
  values: Readonly<Record<string, readonly string[]>>;
}

export function emptyVocabulary(): Vocabulary {
  return { fields: [], types: [], stages: [], values: {} };
}

/* ---------------------------------------------------------------- chips -- */

export type ChipBody =
  | { kind: "type"; label: string; types: string[] }
  | { kind: "filter"; label: string; node: FilterNode }
  | { kind: "sort"; label: string; sort: SortSpec }
  | { kind: "group"; label: string; group: GroupSpec }
  | { kind: "aggregate"; label: string; aggregate: AggregateSpec }
  | { kind: "limit"; label: string; limit: number };

export interface ChipPlace {
  /** Stable within one parse: a Preact key, and the handle for removal. */
  id: string;
  /** Character offsets into the text this was parsed from. */
  start: number;
  end: number;
  /** The words themselves, quoted back so the chip can be checked. */
  source: string;
}

export type Chip = ChipBody & ChipPlace;

export interface ParsedText {
  chips: Chip[];
  /** Runs of words nothing recognised, in the order they were typed. */
  ignored: string[];
}

/* --------------------------------------------------------------- parsing -- */

export function negateBody(body: ChipBody): ChipBody {
  if (body.kind !== "filter") return body;
  return {
    kind: "filter",
    label: `not ${body.label}`,
    node: { kind: "group", combine: "and", negate: true, clauses: [body.node] },
  };
}

/* ------------------------------------------------------------ assembling -- */

/**
 * Chips to a query.
 *
 * `base` carries what the board already had — its columns, and its types and
 * sort when the sentence names neither — so typing into the search box refines
 * the view rather than resetting it.
 *
 * `where` is the exception, and deliberately so: the filter is what the
 * sentence is *for*, so it is built from the chips alone and never merged with
 * a filter that was already there. Deleting a word must be able to remove a
 * condition, which it could not if the two accumulated. The caller is
 * therefore responsible for remembering the board it searched over — see
 * `QueryBoard.applySearch`.
 */
export function chipsToQuery(chips: readonly Chip[], base?: Partial<Query>): Query {
  const query: Query = { ...emptyQuery(), ...base };
  const types = new Set<string>();
  const clauses: FilterNode[] = [];
  const sort: SortSpec[] = [];
  const aggregates: AggregateSpec[] = [];
  let group: GroupSpec | null = base?.group ?? null;
  let limit: number | null = base?.limit ?? null;

  for (const chip of chips) {
    switch (chip.kind) {
      case "type":
        for (const type of chip.types) types.add(type);
        break;
      case "filter":
        clauses.push(chip.node);
        break;
      case "sort":
        sort.push(chip.sort);
        break;
      case "group":
        group = chip.group;
        break;
      case "aggregate":
        aggregates.push(chip.aggregate);
        break;
      case "limit":
        limit = chip.limit;
        break;
    }
  }

  return {
    ...query,
    types: types.size > 0 ? [...types] : (base?.types ?? []),
    where: clauses.length > 0 ? andGroup(clauses) : null,
    sort: sort.length > 0 ? sort : (base?.sort ?? []),
    group,
    aggregates: aggregates.length > 0 ? aggregates : (base?.aggregates ?? []),
    limit,
  };
}

/** Remove a chip from the text it came from, so the box and the chips agree. */
export function textWithoutChip(text: string, chip: ChipPlace): string {
  return `${text.slice(0, chip.start)}${text.slice(chip.end)}`.replace(/\s{2,}/g, " ").trim();
}
