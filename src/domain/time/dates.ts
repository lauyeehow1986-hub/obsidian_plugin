/**
 * Timestamp parsing and human duration formatting.
 *
 * One formatter for the whole plugin (CLAUDE.md §6: "23 days in approval", not
 * 1987200). Pure module: no Obsidian, no Node.
 *
 * Parsing rules, chosen to match what actually lands in frontmatter:
 *
 *  - A bare date (`2026-07-14`) is **UTC midnight**. This is what JS does for
 *    ISO date-only strings, and — critically — also what a YAML parser produces
 *    when it turns an unquoted date into a `Date`. Reading the same note through
 *    the metadata cache (string) or a YAML parse (Date) must not shift by a
 *    timezone offset, so both funnel to the same instant.
 *  - A date-time with no offset (`2026-07-14T09:12`) is **local**. Someone
 *    typing a clock time means their clock.
 *  - A date-time with an offset or `Z` is taken as written.
 *
 * Anything else returns null. We never guess at a timestamp we cannot read: a
 * dwell time computed from a misparsed date is worse than a missing one.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Parse a frontmatter value into epoch milliseconds, or null if unreadable. */
export function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const match = TIMESTAMP_RE.exec(value.trim());
  if (!match) return null;

  const [, date, time, zone] = match;
  if (!isRealCalendarDate(date!) || (time !== undefined && !isRealClockTime(time))) return null;

  const iso = time === undefined ? date! : `${date}T${time}${zone ?? ""}`;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The shape regex is not enough: V8 happily reads `2026-02-30` as 2 March.
 * A date that rolled over silently is a misparse, and a misparsed date feeds a
 * wrong dwell time, so reject it instead.
 */
function isRealCalendarDate(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRealClockTime(time: string): boolean {
  const [h, m, rest] = time.split(":");
  const seconds = rest === undefined ? 0 : Number.parseFloat(rest);
  return (
    Number(h) <= 23 && Number(m) <= 59 && seconds < 61 // a leap second is legal in ISO 8601
  );
}

/** True when `value` is something parseTimestamp can read. */
export function isTimestamp(value: unknown): boolean {
  return parseTimestamp(value) !== null;
}

/** `2026-07-14` in local time — the form the vault writes for dates. */
export function toVaultDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `2026-07-14T14:03` in local time — the form the audit ledger writes. */
export function toVaultMinute(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${toVaultDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-07` — the month a ledger or effort file belongs to. */
export function toVaultMonth(ms: number): string {
  return toVaultDate(ms).slice(0, 7);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Human duration. Days all the way up — "412 days" is less ambiguous than
 * "1.1 years" on a governance report, and this number gets read by people
 * deciding whether something is late.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const abs = Math.abs(ms);
  if (abs < MINUTE_MS) return "under a minute";
  if (abs < HOUR_MS) return plural(Math.floor(abs / MINUTE_MS), "minute");
  if (abs < 2 * DAY_MS) return plural(Math.floor(abs / HOUR_MS), "hour");
  return plural(Math.floor(abs / DAY_MS), "day");
}

/**
 * Whole days elapsed, rounded down. **Calendar days, not working days** — the
 * institutional eData SLAs may well be counted in working days, which is an
 * open question in CLAUDE.md §11. When that is answered this is the one place
 * to change.
 */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}
