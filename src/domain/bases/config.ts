/**
 * `.base` file contents (CLAUDE.md §7 A2b).
 *
 * Core Bases gives native, editable, mobile-friendly tables over frontmatter.
 * That is a lot of grid code we do not have to write or carry in the bundle, so
 * plain browsing is handed to it and our own engine keeps the work Bases cannot
 * do: dwell maths, holdup, medians, anything spanning notes.
 *
 * This module is pure — it builds plain objects. `data/basesFiles.ts` serialises
 * them with Obsidian's core `stringifyYaml` and writes them. The shapes below
 * mirror Obsidian's `BasesConfigFile`; the data layer assigns to that interface,
 * so if the schema ever changes the build fails rather than the vault filling
 * with files Obsidian cannot parse.
 *
 * Everything here was read off the shipped app rather than guessed: the view
 * type id `table` is what Bases inserts when a file declares no views, `groupBy`
 * is rejected unless it carries both `property` and `direction`, and direction
 * is `ASC`/`DESC`.
 *
 * Property ids are prefixed `note.` / `file.` / `formula.` in `filters` and in
 * the `properties` map — but *not* inside a view. Bases accepts `note.stage` in
 * `order` and `groupBy.property`, then rewrites it to bare `stage` the first
 * time the user edits the view. Verified against Obsidian 1.12.7 by generating
 * a file, adding a view in the UI and reading back what Bases wrote. We emit
 * the bare form so the file on disk does not churn the moment it is touched.
 */

export type BaseFilter =
  | string
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter[] };

export interface BaseViewSpec {
  type: string;
  name: string;
  filters?: BaseFilter;
  groupBy?: { property: string; direction: "ASC" | "DESC" };
  order?: string[];
  summaries?: Record<string, string>;
}

export interface BaseConfig {
  filters?: BaseFilter;
  properties?: Record<string, Record<string, unknown>>;
  formulas?: Record<string, string>;
  summaries?: Record<string, string>;
  views?: BaseViewSpec[];
}

/** One `.base` file we know how to generate. */
export interface BaseSpec {
  /** Filename without the extension. */
  name: string;
  /** The note `type` it browses, so the caller can report how many exist. */
  noteType: string;
  /** One line shown in the confirmation before anything is written. */
  purpose: string;
  config: BaseConfig;
}

/** A frontmatter property, as Bases addresses it. */
function note(property: string): string {
  return `note.${property}`;
}

/**
 * Bases filter expressions are a small expression language, not YAML structure.
 * Quoting the value matters: an unquoted bare word is parsed as an identifier.
 */
function isType(noteType: string): string {
  return `note.type == "${noteType}"`;
}

/**
 * Column labels.
 *
 * Without these, Bases shows the raw frontmatter key — `blocked_on`, `sla_days`.
 * Readable headings are cheap here and §6 asks for them.
 */
function labels(pairs: Record<string, string>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [property, displayName] of Object.entries(pairs)) {
    out[note(property)] = { displayName };
  }
  return out;
}

/**
 * Inside a view, properties are named bare — see the note at the top of the
 * file. `order` and `groupBy.property` therefore take the frontmatter key as
 * written, while `properties` and `filters` keep their `note.` prefix.
 */
function table(name: string, order: string[], groupBy?: BaseViewSpec["groupBy"]): BaseViewSpec {
  // Key order matters only because `stringifyYaml` preserves it: emitting the
  // keys in the order Bases itself writes them means a file we generated and a
  // file Bases has rewritten are textually identical, so nothing diffs.
  return groupBy
    ? { type: "table", name, groupBy, order: [...order] }
    : { type: "table", name, order: [...order] };
}

/**
 * The request queue, grouped by stage.
 *
 * Deliberately not a holdup board: dwell time is computed from `history` and
 * Bases cannot express it. Grouping by stage is the honest thing a native table
 * can do well, and the computed boards stay ours (see `registerBasesView`).
 */
function requestQueue(requestType: string): BaseSpec {
  return {
    name: "Request queue",
    noteType: requestType,
    purpose: "Every request, grouped by stage — a native, editable table.",
    config: {
      filters: isType(requestType),
      properties: labels({
        id: "ID",
        title: "Title",
        stage: "Stage",
        blocked_on: "Blocked on",
        blocked_since: "Blocked since",
        requester: "Requester",
        study: "Study",
        assignee: "Assignee",
        priority: "Priority",
        received: "Received",
        due: "Due",
        external_ref: "External ref",
      }),
      views: [
        table(
          "By stage",
          ["id", "title", "blocked_on", "due", "assignee", "priority"],
          { property: "stage", direction: "ASC" },
        ),
        table("All requests", [
          "id",
          "title",
          "stage",
          "blocked_on",
          "received",
          "due",
          "study",
          "external_ref",
        ]),
      ],
    },
  };
}

function publications(): BaseSpec {
  return {
    name: "Publications",
    noteType: "publication",
    purpose: "Manuscripts in flight, grouped by stage.",
    config: {
      filters: isType("publication"),
      properties: labels({
        id: "ID",
        title: "Title",
        stage: "Stage",
        journal: "Journal",
        submitted: "Submitted",
        decision_due: "Decision due",
        scdb_supported: "SCDB supported",
        open_access: "Open access",
      }),
      views: [
        table(
          "In flight",
          ["id", "title", "journal", "submitted", "decision_due", "scdb_supported"],
          { property: "stage", direction: "ASC" },
        ),
      ],
    },
  };
}

function correspondence(): BaseSpec {
  return {
    name: "Correspondence",
    noteType: "correspondence",
    purpose: "Threads, grouped by who the ball is with.",
    config: {
      filters: isType("correspondence"),
      properties: labels({
        id: "ID",
        subject: "Subject",
        channel: "Channel",
        with: "With",
        awaiting: "Awaiting",
        last_outbound: "Last sent",
        last_inbound: "Last reply",
        state: "State",
      }),
      views: [
        table(
          "Open threads",
          ["id", "subject", "with", "last_outbound", "last_inbound", "state"],
          { property: "awaiting", direction: "ASC" },
        ),
      ],
    },
  };
}

function catalogue(): BaseSpec {
  return {
    name: "Variable catalogue",
    noteType: "variable",
    purpose: "The SCDB variable catalogue, grouped by domain.",
    config: {
      filters: isType("variable"),
      properties: labels({
        id: "ID",
        label: "Label",
        domain: "Domain",
        data_type: "Type",
        units: "Units",
        version: "Version",
        identifier: "Identifier",
        source_form: "Source form",
      }),
      views: [
        table(
          "By domain",
          ["id", "label", "data_type", "units", "version", "identifier"],
          { property: "domain", direction: "ASC" },
        ),
      ],
    },
  };
}

/**
 * The `.base` files we offer to generate.
 *
 * Correspondence and the catalogue have no UI yet — those are tracks B and C —
 * but the vault contract (§5.10, §5.8) already defines the note types, so the
 * browse layer can exist before the tooling does. The caller reports how many
 * notes each one currently matches, so an empty table is never a surprise.
 */
export function standardBases(requestType: string): BaseSpec[] {
  return [requestQueue(requestType), publications(), correspondence(), catalogue()];
}
