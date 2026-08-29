/**
 * ClinicalTrials.gov API v2 (§7 E1). Pure: builds URLs, parses responses.
 *
 * Read-only, explicit action only, exactly like `pubmed.ts`.
 *
 * The request names the fields it wants rather than taking whole study records.
 * A full record runs to tens of kilobytes of eligibility prose and site
 * addresses that this feature has no use for, and the smallest defensible
 * request is the one that asks for what it will actually show.
 */

import { DEFAULT_RESULTS, MAX_RESULTS } from "./gateway";

const BASE = "https://clinicaltrials.gov/api/v2/studies";

/**
 * Verified against the live API rather than taken from the documentation.
 * The `|` separator is the one v2 accepts; a comma returns 400.
 */
const FIELDS = [
  "NCTId",
  "BriefTitle",
  "OverallStatus",
  "StudyType",
  "Phase",
  "EnrollmentCount",
  "LeadSponsorName",
  "StartDate",
  "PrimaryCompletionDate",
  "Condition",
  "LocationCountry",
].join("|");

/** The statuses worth filtering by, in the API's own spelling. */
export const TRIAL_STATUSES = [
  "RECRUITING",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
  "COMPLETED",
  "TERMINATED",
  "WITHDRAWN",
] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export interface CtgovSearchOptions {
  /**
   * The condition. Kept separate from `term` because it is the difference
   * between a useful result set and a useless one: a bare `query.term` of
   * "heart failure readmission" returned colorectal cancer and diabetes trials
   * when this was probed against the live service.
   */
  condition?: string;
  term?: string;
  status?: TrialStatus | "";
  pageSize?: number;
}

export function ctgovSearchUrl(options: CtgovSearchOptions): string {
  const size = clamp(options.pageSize);
  const parts = [`format=json`, `countTotal=true`, `pageSize=${size}`, `fields=${FIELDS}`];
  const condition = (options.condition ?? "").trim();
  const term = (options.term ?? "").trim();
  if (condition !== "") parts.push(`query.cond=${encodeURIComponent(condition)}`);
  if (term !== "") parts.push(`query.term=${encodeURIComponent(term)}`);
  const status = options.status ?? "";
  if (status !== "") parts.push(`filter.overallStatus=${encodeURIComponent(status)}`);
  return `${BASE}?${parts.join("&")}`;
}

/** A registry identifier, checked before it can reach a URL. */
export function isNctId(value: string): boolean {
  return /^NCT\d{8}$/.test(value.trim().toUpperCase());
}

function clamp(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.floor(value)));
}

// ---------------------------------------------------------------- parsing ---

export interface TrialRecord {
  nctId: string;
  title: string;
  status: string;
  studyType: string;
  phases: string[];
  enrolment: string;
  sponsor: string;
  start: string;
  primaryCompletion: string;
  conditions: string[];
  countries: string[];
}

export interface CtgovSearchResult {
  studies: TrialRecord[];
  total: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Walk a path of object keys, giving up quietly at the first thing that is not one. */
function dig(root: unknown, ...path: string[]): unknown {
  let here: unknown = root;
  for (const key of path) {
    const record = asRecord(here);
    if (record === null) return undefined;
    here = record[key];
  }
  return here;
}

export function parseCtgovSearch(body: string): CtgovSearchResult | { why: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { why: "ClinicalTrials.gov replied with something that is not JSON." };
  }
  const root = asRecord(json);
  if (root === null) return { why: "ClinicalTrials.gov replied without a result." };
  const list = root["studies"];
  if (!Array.isArray(list)) {
    const message = asString(root["message"]);
    return {
      why:
        message === ""
          ? "ClinicalTrials.gov replied without any studies."
          : `ClinicalTrials.gov said: ${message}`,
    };
  }
  const total = root["totalCount"];
  return {
    studies: list.map(toTrial).filter((trial) => trial.nctId !== ""),
    total: typeof total === "number" && Number.isFinite(total) ? total : list.length,
  };
}

function toTrial(raw: unknown): TrialRecord {
  const p = dig(raw, "protocolSection");
  const enrolment = dig(p, "designModule", "enrollmentInfo", "count");
  const countries = Array.isArray(dig(p, "contactsLocationsModule", "locations"))
    ? (dig(p, "contactsLocationsModule", "locations") as unknown[]).map((loc) =>
        asString(asRecord(loc)?.["country"]),
      )
    : [];
  return {
    nctId: asString(dig(p, "identificationModule", "nctId")),
    title: asString(dig(p, "identificationModule", "briefTitle")).trim(),
    status: asString(dig(p, "statusModule", "overallStatus")),
    studyType: asString(dig(p, "designModule", "studyType")),
    phases: asStringArray(dig(p, "designModule", "phases")),
    enrolment: typeof enrolment === "number" ? String(enrolment) : "",
    sponsor: asString(dig(p, "sponsorCollaboratorsModule", "leadSponsor", "name")),
    start: asString(dig(p, "statusModule", "startDateStruct", "date")),
    primaryCompletion: asString(dig(p, "statusModule", "primaryCompletionDateStruct", "date")),
    conditions: asStringArray(dig(p, "conditionsModule", "conditions")),
    // A multi-site trial lists every site, so "Netherlands" five times is
    // normal. De-duplicated here rather than in the renderer, because every
    // reader of this record wants the distinct set.
    countries: [...new Set(countries.filter((c) => c !== ""))].sort(),
  };
}

/**
 * `NOT_YET_RECRUITING` is the API's spelling, not a person's.
 *
 * §6 asks for human durations; the same argument applies to a status shouted
 * in upper snake case in the middle of a sentence.
 */
export function humanStatus(status: string): string {
  if (status === "") return "Unknown";
  const words = status.toLowerCase().split("_");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/** `PHASE2` and `NA` likewise. */
export function humanPhase(phases: readonly string[]): string {
  const named = phases
    .filter((p) => p !== "NA")
    .map((p) => p.replace(/^PHASE/, "Phase ").replace(/^EARLY_Phase /, "Early phase "));
  return named.join("/");
}
