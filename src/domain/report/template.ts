/**
 * Report templates (CLAUDE.md §7 B7).
 *
 * One engine, several templates. A template is data — prose, named data blocks
 * and live A2 queries, in the order they should be read — and it lives in
 * `_config/reports/` so changing what a monthly report says is a config edit
 * rather than a release. That is the same argument §5.2 makes for the workflow
 * spec, and the same reason: the institutional shape of this work is not ours
 * to hardcode.
 *
 * Five templates ship compiled in, so the feature works in a vault where
 * `_config/reports/` does not exist yet (rule 10, offline-first, and rule 3 —
 * nothing writes to your vault until you ask). A file in `_config/reports/`
 * with the same `id` replaces the built-in of that name; a file with a new id
 * adds a template. "Write the built-in report templates out" is a command, not
 * something that happens on load.
 *
 * Two words in a template mean two different things, and keeping them apart is
 * most of the design:
 *
 *  - **period** — *when*. Filters what happened: effort entries, and which
 *    year's publications are listed. It never filters the queue, because a
 *    queue is a snapshot of now and pretending otherwise would be a
 *    reconstruction this vault cannot honestly make.
 *  - **study** — *what about*. Scopes the whole report to one study: its
 *    requests, its effort, its papers.
 *
 * Pure module: no Obsidian, no Node.
 */

import { EFFORT_DIMENSIONS, type EffortDimension } from "../effort/aggregate";
import { parseQuery, queryToPlain } from "../query/savedView";
import type { Query } from "../query/model";
import { parseCvLayout, type CvSectionSpec } from "../profile/cv";

/** What a template asks the user for before it can run. */
export const PERIOD_KINDS = ["month", "year", "all"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export function isPeriodKind(value: unknown): value is PeriodKind {
  return typeof value === "string" && (PERIOD_KINDS as readonly string[]).includes(value);
}

/**
 * A named data block.
 *
 * Deliberately a closed set rather than an expression language. A template is
 * a file in the vault, and §2 rule 12 is that a note may not become a way to
 * make the plugin do something new — a block name the engine does not
 * recognise is reported, never interpreted.
 */
export type ReportBlock =
  | { kind: "prose"; text: string }
  | { kind: "request-queue" }
  | { kind: "turnaround" }
  | { kind: "bottlenecks" }
  | { kind: "effort"; by: EffortDimension }
  | { kind: "estimate-vs-actual" }
  | { kind: "publications"; scdbOnly: boolean; stages: readonly string[] | null }
  | { kind: "publication-metrics" }
  | { kind: "cv"; layout: readonly CvSectionSpec[] | null }
  | { kind: "portfolio" }
  | { kind: "query"; title: string; query: Query };

export const BLOCK_KINDS: readonly string[] = [
  "prose",
  "request-queue",
  "turnaround",
  "bottlenecks",
  "effort",
  "estimate-vs-actual",
  "publications",
  "publication-metrics",
  "cv",
  "portfolio",
  "query",
];

export interface TemplateSection {
  heading: string;
  lede: string;
  blocks: ReportBlock[];
}

export interface ReportTemplate {
  id: string;
  label: string;
  description: string;
  /** What the dialog asks for. */
  period: PeriodKind;
  /** Whether the report is about one study. */
  study: boolean;
  /** `{period}` and `{study}` are substituted at compose time. */
  title: string;
  sections: TemplateSection[];
  /** Where it came from, for the picker: a vault path, or "" for a built-in. */
  path: string;
}

/* --------------------------------------------------------------- parsing -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function parseBlock(raw: unknown, where: string, problems: string[]): ReportBlock | null {
  // `- prose: |` is the shorthand the shipped templates use, because a wall of
  // `- kind: prose` / `text: |` would make a template twice as long to read as
  // the prose it carries.
  if (typeof raw === "string") return { kind: "prose", text: raw.trim() };
  if (!isRecord(raw)) {
    problems.push(`${where} is not a mapping and was ignored.`);
    return null;
  }

  if (typeof raw["prose"] === "string") return { kind: "prose", text: raw["prose"].trim() };

  const kind = text(raw["block"] ?? raw["kind"]);
  switch (kind) {
    case "prose":
      return { kind: "prose", text: text(raw["text"]) };
    case "request-queue":
    case "turnaround":
    case "bottlenecks":
    case "estimate-vs-actual":
    case "publication-metrics":
    case "portfolio":
      return { kind };
    case "effort": {
      const by = text(raw["by"]);
      if (!(EFFORT_DIMENSIONS as readonly string[]).includes(by)) {
        problems.push(
          `${where} asks for effort \`by: ${by || "(missing)"}\`, which is not one of ${EFFORT_DIMENSIONS.join(", ")}. The block was left out.`,
        );
        return null;
      }
      return { kind: "effort", by: by as EffortDimension };
    }
    case "publications": {
      const stages = Array.isArray(raw["stages"])
        ? raw["stages"].filter((stage): stage is string => typeof stage === "string")
        : null;
      return { kind: "publications", scdbOnly: raw["scdb_only"] === true, stages };
    }
    case "cv":
      return { kind: "cv", layout: parseCvLayout(raw["sections"], problems) };
    case "query": {
      const query = parseQuery(raw["query"] ?? raw, problems);
      return { kind: "query", title: text(raw["title"]), query };
    }
    default:
      problems.push(
        `${where} asks for \`block: ${kind || "(missing)"}\`, which this version does not know how to build. Known blocks: ${BLOCK_KINDS.join(", ")}.`,
      );
      return null;
  }
}

function parseSection(raw: unknown, index: number, problems: string[]): TemplateSection | null {
  if (!isRecord(raw)) {
    problems.push(`sections[${index}] is not a mapping and was ignored.`);
    return null;
  }

  // An empty heading is legitimate, not an omission: the CV template's one
  // section is unheaded because the CV block supplies its own headings, and
  // "Curriculum vitae" printed under a "Curriculum vitae" title reads as a bug.
  const heading = text(raw["heading"]);

  const rawBlocks = raw["blocks"];
  const list = Array.isArray(rawBlocks) ? rawBlocks : rawBlocks === undefined ? [] : [rawBlocks];
  const blocks = list
    .map((entry, position) => parseBlock(entry, `sections[${index}].blocks[${position}]`, problems))
    .filter((block): block is ReportBlock => block !== null);

  if (heading === "" && blocks.length === 0) {
    problems.push(`sections[${index}] has neither a heading nor a block, and was ignored.`);
    return null;
  }

  return { heading, lede: text(raw["lede"]), blocks };
}

export interface ParsedTemplate {
  template: ReportTemplate | null;
  problems: string[];
}

/**
 * Read a template from a parsed YAML object.
 *
 * A template that cannot be read reports why and is not offered — a report
 * built from half a spec is worse than no report, because the half that went
 * missing is invisible in the output.
 */
export function parseTemplate(raw: unknown, path = ""): ParsedTemplate {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { template: null, problems: ["This file is not a YAML mapping."] };
  }

  const id = text(raw["id"]);
  if (id === "") return { template: null, problems: ["A template needs an `id`."] };

  const period = raw["period"] === undefined ? "all" : text(raw["period"]);
  if (!isPeriodKind(period)) {
    problems.push(
      `\`period: ${period}\` is not one of ${PERIOD_KINDS.join(", ")}; the report was treated as covering everything.`,
    );
  }

  const rawSections = raw["sections"];
  if (!Array.isArray(rawSections)) {
    return { template: null, problems: [...problems, "`sections` must be a list."] };
  }

  const sections = rawSections
    .map((entry, index) => parseSection(entry, index, problems))
    .filter((section): section is TemplateSection => section !== null);

  if (sections.length === 0) {
    return { template: null, problems: [...problems, "No section in this template could be read."] };
  }

  const label = text(raw["label"]) || id;
  return {
    template: {
      id,
      label,
      description: text(raw["description"]),
      period: isPeriodKind(period) ? period : "all",
      study: raw["study"] === true,
      title: text(raw["title"]) || label,
      sections,
      path,
    },
    problems,
  };
}

/**
 * The template as a plain object, ready for `stringifyYaml`.
 *
 * Used by the "write the built-in templates out" command, so what lands in
 * `_config/reports/` is the same shape the parser reads back — a file the user
 * edits must not be a second dialect of the one the engine understands.
 */
export function templateToPlain(template: ReportTemplate): Record<string, unknown> {
  return {
    id: template.id,
    label: template.label,
    ...(template.description === "" ? {} : { description: template.description }),
    period: template.period,
    ...(template.study ? { study: true } : {}),
    title: template.title,
    sections: template.sections.map((section) => ({
      heading: section.heading,
      ...(section.lede === "" ? {} : { lede: section.lede }),
      blocks: section.blocks.map(blockToPlain),
    })),
  };
}

function blockToPlain(block: ReportBlock): Record<string, unknown> {
  switch (block.kind) {
    case "prose":
      return { prose: block.text };
    case "effort":
      return { block: "effort", by: block.by };
    case "publications":
      return {
        block: "publications",
        ...(block.scdbOnly ? { scdb_only: true } : {}),
        ...(block.stages === null ? {} : { stages: [...block.stages] }),
      };
    case "cv":
      return {
        block: "cv",
        ...(block.layout === null
          ? {}
          : {
              sections: block.layout.map((section) => ({
                heading: section.heading,
                from:
                  section.source.kind === "publications" ? "publications" : section.source.type,
                ...(section.source.kind === "publications" && section.source.scdbOnly === true
                  ? { scdb_only: true }
                  : {}),
              })),
            }),
      };
    case "query":
      // Through `queryToPlain`, the same serialiser a saved view uses (§5.14).
      // A second one here would drop a filter the first kept, and the template
      // that lost it would still look right.
      return {
        block: "query",
        ...(block.title === "" ? {} : { title: block.title }),
        query: queryToPlain(block.query),
      };
    default:
      return { block: block.kind };
  }
}
