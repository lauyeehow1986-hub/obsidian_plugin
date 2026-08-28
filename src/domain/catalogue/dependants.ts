/**
 * What rests on a catalogue variable (§5.8, §7 C2).
 *
 * §5.8: *"it is the join between everything else. Requests cite variables,
 * REDCap forms create them, scripts consume them, and a policy change alters
 * their definition."* C2 asks for that join in both directions — "see which
 * studies, forms, requests and scripts depend on each one".
 *
 * **Declarable from both ends, the same argument as the policy register.** A
 * variable names the studies that collect it (`collected_in:`) and the form
 * that captures it (`source_form:`); any other note names the variables it
 * consumes (`variables:`). Whoever writes a run record is the person who knows
 * which variables it read, and requiring them to go and edit six catalogue
 * notes to say so is how a dependency map ends up empty.
 *
 * **A citation may name a version** — `VAR-LVEF@2`. That is the interesting
 * case, not an edge case: a script that consumed version 2 while the catalogue
 * has moved to 3 is a real finding, and it is the one this module exists to
 * surface. A citation with no version is not stale, it is *unversioned*, and
 * the two are reported separately because they call for different actions.
 *
 * Pure module: no Obsidian, no Node.
 */

import { refMatchesVariable, refTarget, refVersion, type VariableNote } from "./variable";

/**
 * What kind of note is doing the citing.
 *
 * Closed, because the board groups by it. Derived from the citing note's own
 * `type:` — the note already says what it is, and grouping "form" and "forms"
 * separately would be an avoidable annoyance.
 */
export const DEPENDANT_KINDS = ["study", "form", "request", "script", "run", "policy", "other"] as const;
export type DependantKind = (typeof DEPENDANT_KINDS)[number];

export const DEPENDANT_KIND_LABELS: Record<DependantKind, string> = {
  study: "Studies",
  form: "Forms",
  request: "Requests",
  script: "Scripts",
  run: "Runs",
  policy: "Policies",
  other: "Other notes",
};

const TYPE_KINDS: Record<string, DependantKind> = {
  study: "study",
  "redcap-form": "form",
  "scdb-request": "request",
  "script-doc": "script",
  run: "run",
  policy: "policy",
  variable: "other",
};

/**
 * The frontmatter keys a note may use to cite variables.
 *
 * `variables` is the one §5.12 names on a run record. The rest are here
 * because the same list is what a script doc, a form and a request will
 * reasonably reach for, and a citation the map cannot see is worse than a
 * vocabulary with a spare key in it.
 */
export const CITATION_KEYS = ["variables", "catalogue_variables", "consumes"] as const;

/** One note citing one variable ref, as written. */
export interface Citation {
  /** Path of the note doing the citing. */
  path: string;
  /** Its `type:`, so the kind can be derived. */
  type: string;
  /** Its `id:`, for display. Falls back to the filename at the edges. */
  id: string;
  title: string;
  /** The ref exactly as written, e.g. "[[VAR-LVEF@2]]". */
  ref: string;
  /** Which frontmatter key carried it. */
  field: string;
  /** The version the ref named, or null when it named none. */
  version: number | null;
}

/** Read every variable citation off one note's frontmatter. */
export function noteCitations(
  path: string,
  type: string,
  raw: Record<string, unknown>,
): Citation[] {
  const citations: Citation[] = [];
  const id = str(raw["id"]);
  const title = str(raw["title"]);

  for (const key of CITATION_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const ref = str(entry);
      if (ref === "") continue;
      citations.push({ path, type, id, title, ref, field: key, version: refVersion(ref) });
    }
  }

  return citations;
}

export interface DependantRow {
  kind: DependantKind;
  citation: Citation;
  /** The version the citation named, or null. */
  version: number | null;
  /**
   * True when the citation names a version older than the current one.
   *
   * The finding C2 exists to produce: whatever this note says about the
   * variable was written against a definition that has since moved.
   */
  stale: boolean;
}

export interface DependantGroup {
  kind: DependantKind;
  label: string;
  rows: DependantRow[];
}

export interface VariableDependants {
  variable: VariableNote;
  groups: DependantGroup[];
  total: number;
  /** How many citations name a superseded version. */
  stale: number;
  /** How many name no version at all. */
  unversioned: number;
}

export interface DependantMap {
  /** Keyed by variable path. Every variable appears, including uncited ones. */
  byVariable: Map<string, VariableDependants>;
  /**
   * Citations naming a variable the catalogue does not hold.
   *
   * Reported rather than dropped: a run record consuming `VAR-EGFR` when the
   * catalogue has no such entry means either a typo or an uncatalogued
   * variable, and both are worth someone's attention.
   */
  orphans: Citation[];
  /** Variables nothing cites — the catalogue's dead weight, or its newest entries. */
  uncited: VariableNote[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function kindOf(type: string): DependantKind {
  return TYPE_KINDS[type] ?? "other";
}

/**
 * The citations a variable declares about itself, turned into rows.
 *
 * `collected_in:` names studies and `source_form:` names a form; both are
 * edges on the map, and both come from the variable's own note rather than
 * from the study or the form. Neither carries a version, because a study does
 * not collect one version of a variable — it collects the variable.
 */
function selfDeclared(variable: VariableNote): Citation[] {
  const citations: Citation[] = [];
  for (const ref of variable.collectedIn) {
    citations.push({
      path: variable.path,
      type: "study",
      id: refTarget(ref).toUpperCase(),
      title: ref,
      ref,
      field: "collected_in",
      version: null,
    });
  }
  if (variable.sourceForm !== "") {
    citations.push({
      path: variable.path,
      type: "redcap-form",
      id: refTarget(variable.sourceForm).toUpperCase(),
      title: variable.sourceForm,
      ref: variable.sourceForm,
      field: "source_form",
      version: null,
    });
  }
  return citations;
}

export function buildDependants(input: {
  variables: readonly VariableNote[];
  /** Citations harvested from every other note in the vault. */
  citations: readonly Citation[];
}): DependantMap {
  const byVariable = new Map<string, VariableDependants>();
  const orphans: Citation[] = [];

  const rowsFor = new Map<string, DependantRow[]>();
  for (const variable of input.variables) rowsFor.set(variable.path, []);

  const place = (citation: Citation): boolean => {
    const target = input.variables.find((variable) => refMatchesVariable(citation.ref, variable));
    if (target === undefined) return false;
    rowsFor.get(target.path)!.push({
      kind: kindOf(citation.type),
      citation,
      version: citation.version,
      stale: citation.version !== null && target.version > 0 && citation.version < target.version,
    });
    return true;
  };

  for (const citation of input.citations) {
    // A variable's own note is not a dependant of itself; its `collected_in`
    // and `source_form` come in through `selfDeclared` instead.
    if (citation.type === "variable") continue;
    if (!place(citation)) orphans.push(citation);
  }

  for (const variable of input.variables) {
    for (const citation of selfDeclared(variable)) {
      rowsFor.get(variable.path)!.push({
        kind: kindOf(citation.type),
        citation,
        version: null,
        stale: false,
      });
    }
  }

  const uncited: VariableNote[] = [];
  for (const variable of input.variables) {
    const rows = rowsFor.get(variable.path) ?? [];
    const groups: DependantGroup[] = [];
    for (const kind of DEPENDANT_KINDS) {
      const inKind = rows
        .filter((row) => row.kind === kind)
        .sort((a, b) => a.citation.path.localeCompare(b.citation.path));
      if (inKind.length > 0) {
        groups.push({ kind, label: DEPENDANT_KIND_LABELS[kind], rows: inKind });
      }
    }
    byVariable.set(variable.path, {
      variable,
      groups,
      total: rows.length,
      stale: rows.filter((row) => row.stale).length,
      unversioned: rows.filter((row) => row.version === null).length,
    });
    if (rows.length === 0) uncited.push(variable);
  }

  return { byVariable, orphans, uncited };
}

/** Every citation that names a superseded version, across the catalogue. */
export function staleCitations(map: DependantMap): DependantRow[] {
  const rows: DependantRow[] = [];
  for (const entry of map.byVariable.values()) {
    for (const group of entry.groups) rows.push(...group.rows.filter((row) => row.stale));
  }
  return rows;
}
