/**
 * The research profile — the narrative version of the CV's data (§7 B7).
 *
 * Same notes, different question. A CV asks *what have you done*; a portfolio
 * asks *what is this person's work about, who is it with, and what did the
 * facility contribute*. Both are queries over `84 Profile/`, `85 Publications/`
 * and the request queue, so neither has any data of its own — B7's design rule.
 *
 * Two honesty constraints shape what is computed here:
 *
 *  - **Every number states its denominator** (§6). A headline reading "14
 *    publications" without saying which stages count is a number nobody can
 *    check, and this document goes in front of people who will ask.
 *  - **Nothing is presented as an official record** (§5.1). Turnaround and
 *    delivered counts are what this vault observed; the institutional eData
 *    system remains authoritative. The report footer says so, every time.
 *
 * Pure module: no Obsidian, no Node.
 */

import { partiesIn, type Party } from "../comms/party";
import { totalMins } from "../effort/aggregate";
import type { TimeEntry } from "../effort/entry";
import { yearOf } from "../publication/citation";
import { impactReport } from "../publication/metrics";
import type { PublicationNote } from "../publication/publication";
import type { RequestView } from "../request/holdup";
import { DAY_MS } from "../time/dates";
import { money } from "./cv";
import { profilesOfType, type ProfileNote } from "./profile";

export interface Headline {
  label: string;
  value: string;
  /** The denominator, always. "of 21 papers", "since 2024". */
  note: string;
}

/**
 * A strand of work, keyed on the study the notes already link to.
 *
 * Studies rather than keywords, deliberately: a study is a wikilink somebody
 * typed, so the grouping is something the vault actually asserts. Inferring
 * themes from title words would produce a tidier-looking section that nobody
 * could defend a single row of.
 */
export interface Theme {
  study: string;
  publications: number;
  requests: number;
  grants: number;
  /** Papers this facility supported, of `publications`. */
  scdbSupported: number;
  total: number;
}

export interface Collaborator {
  name: string;
  publications: number;
}

export interface Contribution {
  /** Requests the vault has seen reach a terminal stage. */
  delivered: number;
  live: number;
  medianTurnaroundDays: number | null;
  /** Hours in the effort log the portfolio was built over. */
  hours: number;
  publicationsSupported: number;
  /** Of the papers in print, the share this facility supported, 0–100. */
  supportedShare: number | null;
}

export interface Portfolio {
  headlines: Headline[];
  themes: Theme[];
  collaborators: Collaborator[];
  contribution: Contribution;
  /** True when there is nothing at all to say. Drives the empty state. */
  empty: boolean;
}

export interface PortfolioInput {
  publications: readonly PublicationNote[];
  profile: readonly ProfileNote[];
  views: readonly RequestView[];
  entries: readonly TimeEntry[];
  /** "July 2026", "2026" or "all time" — every number states its window. */
  periodLabel: string;
  now: number;
}

const IN_PRINT: readonly string[] = ["published", "in-press", "accepted"];

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Every study named across publications, requests and grants, counted. */
function themesOf(input: PortfolioInput): Theme[] {
  const byKey = new Map<string, Theme>();

  const bump = (party: Party, field: "publications" | "requests" | "grants", supported = false) => {
    const existing = byKey.get(party.key) ?? {
      study: party.name,
      publications: 0,
      requests: 0,
      grants: 0,
      scdbSupported: 0,
      total: 0,
    };
    existing[field] += 1;
    if (supported) existing.scdbSupported += 1;
    existing.total += 1;
    byKey.set(party.key, existing);
  };

  for (const publication of input.publications) {
    for (const study of publication.studies) {
      bump(study, "publications", publication.scdbSupported);
    }
  }
  for (const view of input.views) {
    for (const study of partiesIn(view.request.study)) bump(study, "requests");
  }
  for (const grant of profilesOfType(input.profile, "grant")) {
    for (const study of grant.studies) bump(study, "grants");
  }

  return [...byKey.values()].sort(
    (a, b) => b.total - a.total || a.study.localeCompare(b.study),
  );
}

/**
 * Co-authors, most frequent first.
 *
 * **Including you.** The vault records your author position but not your name,
 * and guessing which of the names on a paper is yours — by matching initials,
 * say — would be wrong exactly often enough to be embarrassing on a portfolio.
 * The section says plainly that it lists everyone named.
 */
function collaboratorsOf(publications: readonly PublicationNote[]): Collaborator[] {
  const counts = new Map<string, Collaborator>();
  for (const publication of publications) {
    for (const author of publication.authors) {
      const existing = counts.get(author.key);
      if (existing) existing.publications += 1;
      else counts.set(author.key, { name: author.name, publications: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.publications - a.publications || a.name.localeCompare(b.name),
  );
}

function contributionOf(input: PortfolioInput): Contribution {
  const completed = input.views.filter((view) => view.metrics.completed);
  const turnarounds = completed
    .map((view) => view.metrics.turnaroundMs)
    .filter((ms): ms is number => ms !== null)
    .map((ms) => ms / DAY_MS);

  const inPrint = input.publications.filter((publication) =>
    IN_PRINT.includes(publication.stage),
  );
  const supported = inPrint.filter((publication) => publication.scdbSupported).length;
  const days = median(turnarounds);

  return {
    delivered: completed.length,
    live: input.views.length - completed.length,
    medianTurnaroundDays: days === null ? null : round1(days),
    hours: round1(totalMins(input.entries) / 60),
    publicationsSupported: supported,
    supportedShare: inPrint.length === 0 ? null : Math.round((supported / inPrint.length) * 100),
  };
}

function headlinesOf(input: PortfolioInput, contribution: Contribution): Headline[] {
  const impact = impactReport(input.publications);
  const inPrint = input.publications.filter((publication) =>
    IN_PRINT.includes(publication.stage),
  );
  const grants = profilesOfType(input.profile, "grant");
  const supervision = profilesOfType(input.profile, "supervision");
  const presentations = profilesOfType(input.profile, "presentation");

  // **Awarded only.** A grant that has been submitted is not money you have,
  // and a portfolio headline reading "SGD 298,000" that quietly includes a
  // pending application is the kind of number somebody repeats in a meeting.
  // An empty status is treated as awarded, matching `cvLine`, which prints a
  // status only when it is not the ordinary case.
  const awarded = grants.filter(
    (grant) => grant.status === "" || grant.status.toLowerCase() === "awarded",
  );
  const pending = grants.length - awarded.length;

  // Grouped by currency rather than summed: adding SGD to GBP produces a
  // number that is wrong in every currency, and a portfolio is exactly where
  // that would go unchallenged.
  const byCurrency = new Map<string, number>();
  for (const grant of awarded) {
    if (grant.amount === null) continue;
    const key = grant.currency === "" ? "" : grant.currency;
    byCurrency.set(key, (byCurrency.get(key) ?? 0) + grant.amount);
  }
  const funding = [...byCurrency.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([currency, amount]) => money(amount, currency))
    .join(" · ");

  const years = inPrint
    .map((publication) => yearOf(publication).year)
    .filter((year): year is number => year !== null);
  const span =
    years.length === 0
      ? "no dated papers yet"
      : `${Math.min(...years)}–${Math.max(...years)}`;

  const headlines: Headline[] = [
    {
      label: "Publications in print",
      value: String(inPrint.length),
      note: `accepted, in press or published, of ${impact.total} manuscript${impact.total === 1 ? "" : "s"} tracked · ${span}`,
    },
    {
      label: "Papers the facility supported",
      value: String(contribution.publicationsSupported),
      note:
        contribution.supportedShare === null
          ? "no papers in print yet"
          : `${contribution.supportedShare}% of papers in print`,
    },
    {
      label: "Requests delivered",
      value: String(contribution.delivered),
      note:
        contribution.medianTurnaroundDays === null
          ? `${contribution.live} still open · no completed request carries a readable turnaround`
          : `median ${contribution.medianTurnaroundDays} days end to end · ${contribution.live} still open`,
    },
  ];

  if (grants.length > 0) {
    headlines.push({
      label: "Grants",
      value: String(grants.length),
      note:
        (funding === "" ? `${awarded.length} awarded, no amounts recorded` : `${funding} awarded`) +
        (pending === 0 ? "" : ` · ${pending} not yet awarded`),
    });
  }
  if (supervision.length > 0) {
    headlines.push({
      label: "Trainees supervised",
      value: String(supervision.length),
      note: `${supervision.filter((note) => note.outcome !== "").length} with an outcome recorded`,
    });
  }
  if (presentations.length > 0) {
    headlines.push({
      label: "Presentations",
      value: String(presentations.length),
      note: `${presentations.filter((note) => note.invited).length} invited`,
    });
  }
  if (contribution.hours > 0) {
    headlines.push({
      label: "Effort logged",
      value: `${contribution.hours} h`,
      note: `${input.entries.length} time entr${input.entries.length === 1 ? "y" : "ies"} · ${input.periodLabel}`,
    });
  }

  return headlines;
}

export function buildPortfolio(input: PortfolioInput): Portfolio {
  const contribution = contributionOf(input);
  return {
    headlines: headlinesOf(input, contribution),
    themes: themesOf(input),
    collaborators: collaboratorsOf(input.publications),
    contribution,
    empty:
      input.publications.length === 0 &&
      input.profile.length === 0 &&
      input.views.length === 0,
  };
}
