/**
 * The effort vocabularies (CLAUDE.md §5.3).
 *
 * `activity` is a **closed vocabulary**, and closed vocabularies are what make
 * a year of time entries answer a question instead of describing one. Free text
 * gives you "extraction", "Extraction", "data extraction" and "pulling data" as
 * four categories, and the roll-up that was meant to justify a post says
 * nothing.
 *
 * `rework` earns its place in the list on purpose: it is the number that
 * justifies process improvement to people who otherwise hear only anecdotes.
 *
 * The list ships as a default and is **overridable from `_config/vocabularies.
 * yaml`**, because the institution's categories are not ours to fix. Parsing
 * happens here so it can be tested without Obsidian; the caller supplies the
 * already-parsed YAML object.
 *
 * Pure module: no Obsidian, no Node.
 */

/** The shipped vocabulary, verbatim from §5.3. */
export const ACTIVITIES = [
  "intake",
  "scoping",
  "governance-admin",
  "extraction",
  "qc",
  "analysis",
  "reporting",
  "meeting",
  "rework",
  "teaching",
  "other",
] as const;

export type ShippedActivity = (typeof ACTIVITIES)[number];

/**
 * The catch-all. Used when nothing better is known — never guessed at from the
 * note text, because a wrongly-categorised hour is worse than an uncategorised
 * one: it is counted, and counted in the wrong column.
 */
export const FALLBACK_ACTIVITY: ShippedActivity = "other";

export interface Vocabularies {
  /** Effective activity list: the file's, or the shipped default. */
  activities: string[];
  /** Cost centres offered in the timer dialog. Free text is still allowed. */
  costCentres: string[];
  /** True when a `_config/vocabularies.yaml` supplied the activity list. */
  fromFile: boolean;
}

export function defaultVocabularies(): Vocabularies {
  return { activities: [...ACTIVITIES], costCentres: [], fromFile: false };
}

/**
 * The activity a hat starts on (§7 A3: mode "changes the default activity
 * category for the timer").
 *
 * A starting value, never a silent one — the timer dialog always shows it and
 * it is always editable. Attributing an hour to the wrong category without
 * being asked is exactly the failure that makes an effort log untrustworthy.
 */
export function defaultActivityFor(mode: string): ShippedActivity {
  switch (mode) {
    case "biostat":
      return "analysis";
    case "research-core":
      return "governance-admin";
    case "hod":
    default:
      return "extraction";
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export interface ParsedVocabularies {
  vocab: Vocabularies;
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

/**
 * Read `_config/vocabularies.yaml`.
 *
 * A file that cannot be read **falls back to the shipped list and says so**. It
 * does not fall back to "no vocabulary": an empty list would refuse every
 * activity and stop the timer writing anything, which turns a typo in a config
 * file into a day of lost time entries.
 */
export function parseVocabularies(raw: unknown): ParsedVocabularies {
  const vocab = defaultVocabularies();
  const problems: string[] = [];

  if (raw === null || raw === undefined) return { vocab, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      vocab,
      problems: ["vocabularies.yaml is not a set of keys. Using the built-in activity list."],
    };
  }

  const record = raw as Record<string, unknown>;

  if ("activities" in record) {
    const activities = stringList(record["activities"]);
    if (activities === null) {
      problems.push("`activities` is not a list. Using the built-in activity list.");
    } else if (activities.length === 0) {
      problems.push("`activities` is empty. Using the built-in activity list.");
    } else {
      vocab.activities = activities;
      vocab.fromFile = true;
    }
  }

  if ("cost_centres" in record || "cost_centers" in record) {
    const centres = stringList(record["cost_centres"] ?? record["cost_centers"]);
    if (centres === null) problems.push("`cost_centres` is not a list. Ignoring it.");
    else vocab.costCentres = centres;
  }

  return { vocab, problems };
}

/** True when `activity` is in the effective vocabulary. Case-sensitive, as written. */
export function isKnownActivity(vocab: Vocabularies, activity: string): boolean {
  return vocab.activities.includes(activity);
}

/**
 * The activity to start a new entry on, given a preferred one.
 *
 * Falls back to the first entry of the effective vocabulary rather than to
 * `other`, because a vocabulary loaded from file may not contain `other` at
 * all — offering a value the log would then flag is a dead end.
 */
export function activityOrFallback(vocab: Vocabularies, preferred: string): string {
  if (isKnownActivity(vocab, preferred)) return preferred;
  if (isKnownActivity(vocab, FALLBACK_ACTIVITY)) return FALLBACK_ACTIVITY;
  return vocab.activities[0] ?? FALLBACK_ACTIVITY;
}
