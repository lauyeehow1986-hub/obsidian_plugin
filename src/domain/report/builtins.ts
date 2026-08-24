/**
 * The five templates B7 names, compiled in (CLAUDE.md §7 B7).
 *
 * Held as typed objects rather than as YAML strings parsed at load: a template
 * that ships broken should be a compile error, not a notice on a Monday
 * morning. `templateToPlain` turns any of them back into the YAML the user
 * edits, so the two never diverge.
 *
 * The prose is short on purpose. A report template's prose is the part that
 * says what the reader is looking at and what it does *not* claim; padding it
 * with commentary teaches people to skip the paragraph that matters.
 *
 * Pure module: no Obsidian, no Node.
 */

import { DEFAULT_CV_LAYOUT } from "../profile/cv";
import type { ReportTemplate } from "./template";

/**
 * Said wherever a queue appears in a periodic report.
 *
 * The queue is the one thing in this engine that cannot honour the period, and
 * a reader comparing July's report to August's will assume both queues are
 * as-at-month-end unless told otherwise. Reconstructing the queue as it stood
 * on 31 July is possible from `history` and is not attempted — a number that
 * looks reconstructed but is not is worse than one that says what it is.
 */
const QUEUE_CAVEAT =
  "The queue is as at the moment this report was generated, not as at the end of the period — " +
  "a queue is a snapshot and this vault does not reconstruct past ones.";

const MONTHLY_FACILITY: ReportTemplate = {
  id: "monthly-facility",
  label: "Monthly facility report",
  description: "Queue, turnaround, effort and bottlenecks for one month.",
  period: "month",
  study: false,
  title: "SCDB monthly report — {period}",
  path: "",
  sections: [
    {
      heading: "The queue",
      lede: QUEUE_CAVEAT,
      blocks: [{ kind: "request-queue" }],
    },
    {
      heading: "Turnaround",
      lede: "How long requests are taking, and which stage they wait in.",
      blocks: [{ kind: "turnaround" }],
    },
    {
      heading: "Effort",
      lede: "Time logged in {period}.",
      blocks: [
        { kind: "effort", by: "activity" },
        { kind: "effort", by: "study" },
      ],
    },
    {
      heading: "Bottlenecks",
      lede: "Where the work stops, and with whom.",
      blocks: [{ kind: "bottlenecks" }],
    },
  ],
};

const STUDY_EFFORT: ReportTemplate = {
  id: "study-effort",
  label: "Per-study effort statement",
  description: "Hours by activity, person and request for one study — the chargeback line.",
  period: "month",
  study: true,
  title: "Effort statement — {study}, {period}",
  path: "",
  sections: [
    {
      heading: "What this covers",
      lede: "",
      blocks: [
        {
          kind: "prose",
          text:
            "Time recorded against {study} in {period}, taken from the monthly effort logs in " +
            "the vault. Entries with no study recorded against them are not included here, so " +
            "this is a floor rather than a full account of the work.",
        },
        { kind: "effort", by: "activity" },
      ],
    },
    {
      heading: "By person",
      lede: "",
      blocks: [{ kind: "effort", by: "person" }],
    },
    {
      heading: "By request",
      lede: "",
      blocks: [{ kind: "effort", by: "ref" }],
    },
    {
      heading: "Against estimate",
      lede: "Every request for this study that carries an estimate, against all time ever logged to it.",
      blocks: [{ kind: "estimate-vs-actual" }],
    },
  ],
};

const PUBLICATION_LIST: ReportTemplate = {
  id: "publication-list",
  label: "Annual publication list",
  description: "The formatted list for one year, with the facility's contribution.",
  period: "year",
  study: false,
  title: "Publications — {period}",
  path: "",
  sections: [
    {
      heading: "",
      lede: "",
      blocks: [{ kind: "publications", scdbOnly: false, stages: null }],
    },
    {
      heading: "Metrics",
      lede: "",
      blocks: [{ kind: "publication-metrics" }],
    },
  ],
};

const CV: ReportTemplate = {
  id: "cv",
  label: "Curriculum vitae",
  description: "Composed from 85 Publications/ and 84 Profile/. Never out of date, because it is a query.",
  period: "all",
  study: false,
  title: "Curriculum vitae",
  path: "",
  sections: [
    {
      // Unheaded: the CV block supplies the section headings, and a "Curriculum
      // vitae" heading under a "Curriculum vitae" title says it twice.
      heading: "",
      lede: "",
      blocks: [{ kind: "cv", layout: DEFAULT_CV_LAYOUT }],
    },
  ],
};

const RESEARCH_PROFILE: ReportTemplate = {
  id: "research-profile",
  label: "Research profile",
  description: "The narrative version: themes, headline metrics, collaborations, the facility's contribution.",
  period: "all",
  study: false,
  title: "Research profile",
  path: "",
  sections: [
    {
      heading: "At a glance",
      lede: "",
      blocks: [{ kind: "portfolio" }],
    },
    {
      heading: "Work the facility supported",
      lede: "",
      blocks: [
        {
          kind: "prose",
          text:
            "The papers below were produced with data this facility collected, extracted or " +
            "curated. It is the number that answers what a data collection facility is for.",
        },
        { kind: "publications", scdbOnly: true, stages: null },
      ],
    },
  ],
};

export const BUILT_IN_TEMPLATES: readonly ReportTemplate[] = [
  MONTHLY_FACILITY,
  STUDY_EFFORT,
  PUBLICATION_LIST,
  CV,
  RESEARCH_PROFILE,
];
