/**
 * The catalogue board's model (§7 C2) — browse, search, and what needs attention.
 *
 * One row per variable, carrying everything the board shows so the component
 * stays presentational: the parsed note, what rests on it, what is wrong with
 * its version chain, and where it sits in the catalogue's own domains.
 *
 * The summary counts are chosen to answer the questions an HOD of a data
 * collection facility is actually asked about the catalogue — how much of it
 * is identifiable, how much of it nothing uses, and how much of what uses it
 * was written against a definition that has since moved.
 *
 * Pure module: no Obsidian, no Node.
 */

import { chainProblems } from "./lineage";
import { buildDependants, type Citation, type DependantMap, type VariableDependants } from "./dependants";
import { dataTypeLabel, variableLabel, type VariableNote } from "./variable";

export interface CatalogueRow {
  variable: VariableNote;
  dependants: VariableDependants;
  /** Problems with the version chain, on top of the note's own. */
  chain: string[];
  /** Everything wrong with this entry, in one list for the "needs attention" chip. */
  problems: string[];
}

export interface CatalogueGroup {
  /** The `domain:` value, or "" for the ungrouped. */
  domain: string;
  label: string;
  rows: CatalogueRow[];
}

export interface CatalogueSummary {
  total: number;
  /** Variables flagged `identifier: true`. */
  identifiers: number;
  /** Identifiers with no recorded justification — the governance finding. */
  unjustified: number;
  /** Variables past version 1. */
  revised: number;
  /** Variables nothing in the vault cites. */
  uncited: number;
  /** Citations naming a superseded version. */
  stale: number;
  /** Citations naming a variable the catalogue does not hold. */
  orphans: number;
  needsAttention: number;
}

export interface Catalogue {
  rows: CatalogueRow[];
  groups: CatalogueGroup[];
  summary: CatalogueSummary;
  map: DependantMap;
}

export function buildCatalogue(input: {
  variables: readonly VariableNote[];
  citations: readonly Citation[];
}): Catalogue {
  const map = buildDependants({ variables: input.variables, citations: input.citations });

  const rows: CatalogueRow[] = input.variables.map((variable) => {
    const chain = chainProblems(variable);
    const dependants = map.byVariable.get(variable.path)!;
    return {
      variable,
      dependants,
      chain,
      problems: [...variable.problems, ...chain],
    };
  });

  rows.sort(
    (a, b) =>
      a.variable.domain.localeCompare(b.variable.domain) ||
      a.variable.id.localeCompare(b.variable.id) ||
      a.variable.path.localeCompare(b.variable.path),
  );

  const groups: CatalogueGroup[] = [];
  for (const row of rows) {
    const domain = row.variable.domain;
    const existing = groups.find((group) => group.domain === domain);
    if (existing === undefined) {
      groups.push({ domain, label: domain === "" ? "No domain set" : domain, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  const identifiers = rows.filter((row) => row.variable.identifier);
  const summary: CatalogueSummary = {
    total: rows.length,
    identifiers: identifiers.length,
    unjustified: identifiers.filter((row) => row.variable.justification === "").length,
    revised: rows.filter((row) => row.variable.version > 1).length,
    uncited: map.uncited.length,
    stale: rows.reduce((sum, row) => sum + row.dependants.stale, 0),
    orphans: map.orphans.length,
    needsAttention: rows.filter((row) => row.problems.length > 0).length,
  };

  return { rows, groups, summary, map };
}

/**
 * Free-text search across the catalogue.
 *
 * Matches id, label, domain, units, definition and coding labels — everything
 * a person might half-remember about a variable. Deliberately not the query
 * engine: this is a filter box on a board, and A2's engine is one command
 * away for anything structured.
 */
export function searchCatalogue(rows: readonly CatalogueRow[], query: string): CatalogueRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];

  return rows.filter((row) => {
    const { variable } = row;
    const haystack = [
      variable.id,
      variable.label,
      variable.domain,
      variable.units,
      variable.definition,
      dataTypeLabel(variable.dataType),
      ...variable.coding.map((code) => `${code.code} ${code.label}`),
      ...variable.collectedIn,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** How a catalogue row is named in a notice or a picker. */
export function rowLabel(row: CatalogueRow): string {
  return variableLabel(row.variable);
}
