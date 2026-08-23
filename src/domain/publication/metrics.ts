/**
 * Publication metrics and the SCDB impact report (CLAUDE.md §5.4, §7 B5).
 *
 * §5.4 names four numbers: count by stage, median time to first decision,
 * resubmission counts, and journals where the department lands. Plus the one it
 * calls "the single most useful number an HOD can put in front of a funding
 * committee" — how many papers the facility made possible.
 *
 * Everything is derived from `history`, never stored, for the same reason §5.1
 * gives for dwell time: a number duplicated into frontmatter is a number that
 * goes stale without telling anyone.
 *
 * **Every count states its denominator** (§6). A median over three papers is
 * not a fact about the department, and a report that does not say how many it
 * measured invites the reader to assume it measured all of them.
 *
 * Pure module: no Obsidian, no Node.
 */

import { DAY_MS } from "../time/dates";
import { median } from "../stats/summary";
import {
  PUBLICATION_STAGES,
  stageLabel,
  type PublicationNote,
  type PublicationStage,
} from "./publication";
import { yearOf } from "./citation";

/** Stages that mean the journal has answered. */
const DECISIONS: readonly string[] = ["revision", "accepted", "rejected"];

export interface StageCount {
  stage: PublicationStage;
  label: string;
  count: number;
}

/**
 * How many manuscripts sit in each stage.
 *
 * Every stage is listed, including the empty ones: "nothing in revision" is a
 * fact about the pipeline, and a bar chart that silently drops it changes the
 * shape of the picture. Notes carrying a stage §5.4 does not name are counted
 * separately rather than folded in.
 */
export function countByStage(publications: readonly PublicationNote[]): {
  counts: StageCount[];
  unrecognised: { stage: string; count: number }[];
  total: number;
} {
  const tally = new Map<string, number>();
  for (const publication of publications) {
    const key = publication.stage === "" ? "(none)" : publication.stage;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const counts: StageCount[] = PUBLICATION_STAGES.map((stage) => ({
    stage,
    label: stageLabel(stage),
    count: tally.get(stage) ?? 0,
  }));

  const known = new Set<string>(PUBLICATION_STAGES);
  const unrecognised = [...tally.entries()]
    .filter(([stage]) => !known.has(stage))
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);

  return { counts, unrecognised, total: publications.length };
}

export interface DecisionTime {
  publication: PublicationNote;
  /** Days from first submission to the journal's first answer. */
  days: number;
  /** Which stage the answer was. */
  decision: string;
}

/**
 * Time from first submission to first decision, per manuscript.
 *
 * "First" on both ends is deliberate. A paper rejected, revised and resubmitted
 * has several submissions and several decisions; the number a department wants
 * is how long a journal takes to answer, and pairing the first with the first
 * is the only pairing that measures that rather than measuring our own revision
 * speed.
 *
 * A manuscript whose history does not contain a submission followed by a
 * decision contributes nothing — not a zero. A zero would drag the median down
 * and mean "answered instantly", which is not what "we have not heard back"
 * means.
 */
export function decisionTimes(publications: readonly PublicationNote[]): DecisionTime[] {
  const times: DecisionTime[] = [];
  for (const publication of publications) {
    const submitted = publication.history.find((entry) => entry.to === "submitted");
    if (!submitted) continue;
    const decision = publication.history.find(
      (entry) => entry.at >= submitted.at && DECISIONS.includes(entry.to),
    );
    if (!decision) continue;
    times.push({
      publication,
      days: Math.round((decision.at - submitted.at) / DAY_MS),
      decision: decision.to,
    });
  }
  return times.sort((a, b) => a.days - b.days);
}

/** Median days to a first decision, with the count it was measured over. */
export function medianDecisionDays(publications: readonly PublicationNote[]): {
  days: number | null;
  measured: number;
  /** Manuscripts submitted but still waiting — the ones the median cannot see. */
  awaiting: number;
} {
  const times = decisionTimes(publications);
  const submitted = publications.filter((publication) =>
    publication.history.some((entry) => entry.to === "submitted"),
  ).length;
  const days = median(times.map((time) => time.days));
  return {
    days: days === null ? null : Math.round(days),
    measured: times.length,
    awaiting: submitted - times.length,
  };
}

export interface Resubmission {
  publication: PublicationNote;
  /** Submissions after the first. Zero for a paper accepted where it was sent. */
  count: number;
  /** Each journal it went to, in order, as far as history records them. */
  journeys: string[];
}

/**
 * How many times each manuscript went back out.
 *
 * The same argument as the request bounce count (§5.1): a paper on its third
 * journal looks identical to a fresh submission if you only read the current
 * stage, and the rework is invisible exactly where it matters most.
 */
export function resubmissions(publications: readonly PublicationNote[]): Resubmission[] {
  return publications
    .map((publication) => {
      const submissions = publication.history.filter((entry) => entry.to === "submitted");
      const journeys: string[] = [];
      for (const entry of submissions) {
        const journal = entry.journal || (journeys.length === 0 ? publication.journal : "");
        if (journal !== "" && journal !== journeys[journeys.length - 1]) journeys.push(journal);
      }
      // The journal it currently sits at may post-date the last history entry.
      if (publication.journal !== "" && !journeys.includes(publication.journal)) {
        journeys.push(publication.journal);
      }
      return {
        publication,
        count: Math.max(0, submissions.length - 1),
        journeys,
      };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
}

export interface JournalCount {
  journal: string;
  /** Manuscripts that landed here — accepted, in press or published. */
  landed: number;
  /** Manuscripts this journal turned down. */
  rejected: number;
  scdbSupported: number;
}

const LANDED: readonly string[] = ["accepted", "in-press", "published"];

/**
 * Where the department's work ends up.
 *
 * Rejections are counted alongside acceptances rather than hidden, because
 * "we send to this journal a lot and it never takes us" is the more actionable
 * half of the picture. A rejection is only attributed to the journal history
 * names — a paper rejected and moved on carries the new journal in
 * `journal:`, so guessing from that would blame the wrong one.
 */
export function journalLandings(publications: readonly PublicationNote[]): JournalCount[] {
  const tally = new Map<string, JournalCount>();
  const at = (journal: string): JournalCount => {
    const existing = tally.get(journal);
    if (existing) return existing;
    const fresh: JournalCount = { journal, landed: 0, rejected: 0, scdbSupported: 0 };
    tally.set(journal, fresh);
    return fresh;
  };

  for (const publication of publications) {
    if (LANDED.includes(publication.stage) && publication.journal !== "") {
      const entry = at(publication.journal);
      entry.landed += 1;
      if (publication.scdbSupported) entry.scdbSupported += 1;
    }
    if (publication.stage === "rejected" && publication.journal !== "") {
      at(publication.journal).rejected += 1;
    }
    // A rejection recorded in history, on a paper that has since moved on.
    const rejection = publication.history.find((entry) => entry.to === "rejected");
    if (rejection && publication.stage !== "rejected") {
      const before = journalBefore(publication, rejection.at);
      if (before !== "") at(before).rejected += 1;
    }
  }

  return [...tally.values()].sort(
    (a, b) => b.landed - a.landed || b.rejected - a.rejected || a.journal.localeCompare(b.journal),
  );
}

/** Which journal the manuscript was at on a given date, as far as history says. */
function journalBefore(publication: PublicationNote, at: number): string {
  let journal = "";
  for (const entry of publication.history) {
    if (entry.at > at) break;
    if (entry.journal !== "") journal = entry.journal;
  }
  // Nothing in history named one, so the only candidate is the current field —
  // and only if the paper has not moved since.
  return journal;
}

export interface ImpactReport {
  /** Every publication the report was computed over. */
  total: number;
  scdbSupported: number;
  /** Of those the facility supported, how many are in print. */
  scdbPublished: number;
  byStage: ReturnType<typeof countByStage>;
  decision: ReturnType<typeof medianDecisionDays>;
  resubmissions: Resubmission[];
  journals: JournalCount[];
  /** SCDB-supported output per year, newest first. */
  perYear: { year: number | null; total: number; scdbSupported: number }[];
}

/**
 * The whole picture, computed once.
 *
 * One function rather than five calls at the UI, so a board and an exported
 * report cannot drift into showing different numbers for the same vault.
 */
export function impactReport(publications: readonly PublicationNote[]): ImpactReport {
  const perYear = new Map<number | null, { total: number; scdbSupported: number }>();
  for (const publication of publications) {
    if (!LANDED.includes(publication.stage)) continue;
    const { year } = yearOf(publication);
    const bucket = perYear.get(year) ?? { total: 0, scdbSupported: 0 };
    bucket.total += 1;
    if (publication.scdbSupported) bucket.scdbSupported += 1;
    perYear.set(year, bucket);
  }

  const supported = publications.filter((publication) => publication.scdbSupported);

  return {
    total: publications.length,
    scdbSupported: supported.length,
    scdbPublished: supported.filter((publication) => LANDED.includes(publication.stage)).length,
    byStage: countByStage(publications),
    decision: medianDecisionDays(publications),
    resubmissions: resubmissions(publications),
    journals: journalLandings(publications),
    perYear: [...perYear.entries()]
      .map(([year, counts]) => ({ year, ...counts }))
      .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity)),
  };
}
