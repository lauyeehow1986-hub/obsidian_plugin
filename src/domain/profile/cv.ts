/**
 * Composing a CV from notes (CLAUDE.md §5.9, §7 B7).
 *
 * The design rule B7 states, and the reason this file is short: **the CV
 * templates own layout only.** No CV-specific data lives outside `84 Profile/`
 * and `85 Publications/`, so adding a section never means re-entering data. All
 * this module does is decide which notes belong in which section, in what
 * order, and what one line of each reads like.
 *
 * The section layout is configurable because CV conventions are institutional,
 * not universal — §11 records that which format the institution actually wants
 * is still an open question. A layout is a list of section specs, so answering
 * that question later is a config edit rather than a code change.
 *
 * One rule is *not* configurable: a manuscript still in drafting is not a
 * publication, and listing it on a CV would be a misrepresentation. That is
 * enforced in `citation.formatList`, whose stage default this file inherits.
 *
 * Pure module: no Obsidian, no Node.
 */

import { formatList, type CitationFormat, type YearGroup } from "../publication/citation";
import type { PublicationNote } from "../publication/publication";
import {
  periodText,
  profilesOfType,
  type ProfileNote,
  type ProfileType,
} from "./profile";

/** Where a section's rows come from. */
export type CvSource =
  | { kind: "publications"; scdbOnly?: boolean; stages?: readonly string[] }
  | { kind: "profile"; type: ProfileType };

export interface CvSectionSpec {
  /**
   * The heading is the identity.
   *
   * There is deliberately no `id`: nothing downstream addresses a CV section
   * by anything but its heading, and an id that the YAML does not carry would
   * be a field a written-out template loses on the way back in.
   */
  heading: string;
  /** One line under the heading. Optional; empty prints nothing. */
  lede?: string;
  source: CvSource;
}

/**
 * The default layout.
 *
 * Ordered the way a research CV is read: what you have published, what you were
 * funded to do, who you trained, what you taught, where you spoke, what you
 * were given, and what you serve on. Every section is optional at render time —
 * one with nothing in it is dropped rather than printed empty, because a CV
 * with a blank "Awards" heading says something the data does not.
 */
export const DEFAULT_CV_LAYOUT: readonly CvSectionSpec[] = [
  { heading: "Publications", source: { kind: "publications" } },
  { heading: "Grants and funding", source: { kind: "profile", type: "grant" } },
  { heading: "Supervision", source: { kind: "profile", type: "supervision" } },
  { heading: "Teaching", source: { kind: "profile", type: "teaching" } },
  { heading: "Presentations", source: { kind: "profile", type: "presentation" } },
  { heading: "Awards", source: { kind: "profile", type: "award" } },
  { heading: "Service", source: { kind: "profile", type: "service" } },
] as const;

export interface CvEntry {
  /** "2024–2027", "2026" or "" — the left column of a CV. */
  when: string;
  /** The item itself, as one line of plain text. Never markdown. */
  text: string;
  /** The note it came from, so the reader can click through in the vault. */
  path: string;
  problems: string[];
}

export interface CvSection {
  heading: string;
  lede: string;
  /** Profile-derived sections. Empty for a publications section. */
  entries: CvEntry[];
  /** Publications, already grouped by year and formatted. Empty otherwise. */
  years: YearGroup[];
  /** Rows in the section, whichever shape it took. */
  count: number;
}

export interface CvInput {
  profile: readonly ProfileNote[];
  publications: readonly PublicationNote[];
  format: CitationFormat;
  layout?: readonly CvSectionSpec[];
}

export interface Cv {
  sections: CvSection[];
  /** Every section's count, so a caller can say "nothing to build" honestly. */
  total: number;
  /** Author names the splitter was unsure of, deduplicated. Worth checking. */
  uncertainAuthors: string[];
}

/** Join the parts of a line, dropping the ones the note did not fill in. */
function sentence(parts: (string | null | undefined)[]): string {
  const kept = parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .map((part) => (part.endsWith(".") ? part.slice(0, -1) : part));
  return kept.length === 0 ? "" : `${kept.join(". ")}.`;
}

/** "SGD 250,000", "250,000", or "" — the currency is never invented. */
export function money(amount: number | null, currency: string): string {
  if (amount === null) return "";
  const figure = amount.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return currency === "" ? figure : `${currency} ${figure}`;
}

/** One profile note as a CV line. Presentation only — no filtering happens here. */
export function cvLine(note: ProfileNote): string {
  switch (note.type) {
    case "grant":
      return sentence([
        note.title,
        note.agency === "" ? "" : note.ref === "" ? note.agency : `${note.agency} (${note.ref})`,
        note.role,
        money(note.amount, note.currency),
        // Only said when it is not the ordinary case: every grant on a CV is
        // assumed awarded, and printing "Awarded" on all of them is noise,
        // while omitting "Submitted" on one would be a misrepresentation.
        note.status.toLowerCase() === "awarded" ? "" : note.status,
      ]);
    case "service":
      return sentence([
        note.title,
        note.position,
        note.organisation,
        note.scope === "" ? "" : `${note.scope} scope`,
      ]);
    case "teaching":
      return sentence([
        note.title,
        note.role,
        note.institution,
        note.level,
        note.hours === null ? "" : `${note.hours} h`,
      ]);
    case "supervision":
      return sentence([note.trainee || note.title, note.degree, note.role, note.outcome]);
    case "presentation":
      return sentence([
        note.title,
        note.meeting,
        note.location,
        [note.format, note.invited ? "invited" : ""].filter((part) => part !== "").join(", "),
      ]);
    case "award":
      return sentence([note.title, note.body]);
  }
}

/** The date column: a presentation's own date beats the period it derived. */
function whenOf(note: ProfileNote): string {
  if (note.type === "presentation" && note.date !== "") return note.date;
  return periodText(note.period);
}

function profileSection(spec: CvSectionSpec, notes: readonly ProfileNote[]): CvSection {
  const type = spec.source.kind === "profile" ? spec.source.type : null;
  const entries =
    type === null
      ? []
      : profilesOfType(notes, type).map((note) => ({
          when: whenOf(note),
          text: cvLine(note),
          path: note.path,
          problems: note.problems,
        }));

  return {
    heading: spec.heading,
    lede: spec.lede ?? "",
    entries,
    years: [],
    count: entries.length,
  };
}

function publicationSection(
  spec: CvSectionSpec,
  publications: readonly PublicationNote[],
  format: CitationFormat,
): CvSection {
  const source = spec.source as Extract<CvSource, { kind: "publications" }>;
  const years = formatList(publications, {
    format,
    ...(source.scdbOnly === undefined ? {} : { scdbOnly: source.scdbOnly }),
    ...(source.stages === undefined ? {} : { stages: source.stages }),
  });

  return {
    heading: spec.heading,
    lede: spec.lede ?? "",
    entries: [],
    years,
    count: years.reduce((sum, group) => sum + group.citations.length, 0),
  };
}

/**
 * Build the CV.
 *
 * Empty sections are dropped, not printed empty: a heading with nothing under
 * it reads as a gap in the record rather than as a section you have not filled
 * in yet, and the two are very different things to a reader on a panel.
 */
export function composeCv(input: CvInput): Cv {
  const layout = input.layout ?? DEFAULT_CV_LAYOUT;
  const sections: CvSection[] = [];
  const uncertain = new Set<string>();

  for (const spec of layout) {
    const section =
      spec.source.kind === "publications"
        ? publicationSection(spec, input.publications, input.format)
        : profileSection(spec, input.profile);

    for (const group of section.years) {
      for (const citation of group.citations) {
        for (const name of citation.uncertain) uncertain.add(name.raw);
      }
    }
    if (section.count > 0) sections.push(section);
  }

  return {
    sections,
    total: sections.reduce((sum, section) => sum + section.count, 0),
    uncertainAuthors: [...uncertain].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Read a layout out of a template's YAML.
 *
 * Unknown section sources are reported rather than dropped silently: a typo in
 * `type: presentations` would otherwise produce a CV missing a section, which
 * is exactly the kind of quiet omission nobody notices until it is in front of
 * a panel.
 */
export function parseCvLayout(
  raw: unknown,
  problems: string[],
): CvSectionSpec[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    problems.push("`sections` is not a list, so the default CV layout was used.");
    return null;
  }

  const layout: CvSectionSpec[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`sections[${index}] is not a mapping and was ignored.`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const from = typeof record["from"] === "string" ? record["from"].trim() : "";
    const heading = typeof record["heading"] === "string" ? record["heading"].trim() : "";
    if (heading === "") {
      problems.push(`sections[${index}] has no \`heading\` and was ignored.`);
      return;
    }

    const lede = typeof record["lede"] === "string" ? record["lede"].trim() : "";
    const base = { heading, ...(lede === "" ? {} : { lede }) };

    if (from === "publications") {
      layout.push({
        ...base,
        source: {
          kind: "publications",
          ...(record["scdb_only"] === undefined ? {} : { scdbOnly: record["scdb_only"] === true }),
          ...(Array.isArray(record["stages"])
            ? { stages: record["stages"].filter((s): s is string => typeof s === "string") }
            : {}),
        },
      });
      return;
    }

    const known = (["grant", "service", "teaching", "supervision", "presentation", "award"] as const).find(
      (type) => type === from,
    );
    if (known === undefined) {
      problems.push(
        `sections[${index}] reads \`from: ${from || "(missing)"}\`, which is not a profile note type or "publications". The section was left out.`,
      );
      return;
    }
    layout.push({ ...base, source: { kind: "profile", type: known } });
  });

  return layout.length === 0 ? null : layout;
}
