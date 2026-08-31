/**
 * iCalendar (RFC 5545) emit and parse — the offline bridge to Outlook's
 * calendar (CLAUDE.md §7 B3).
 *
 * No Graph API, no credentials, no live mailbox: a file goes out, a file comes
 * back. Pure string work, so no dependency (§7 B3 says so explicitly) and no
 * Obsidian, no Node.
 *
 * **Governance line, same as §5.11.** An `.ics` is a file that travels — into
 * Outlook, onto a phone, into whatever backs up the mailbox. Summaries carry
 * `REQ-` refs, dates, titles and the `consequence` the note already states.
 * Nothing else. There is no path from a note body into this file.
 */

/** Lines are CRLF-terminated. Outlook is tolerant; the spec is not. */
const CRLF = "\r\n";

/** RFC 5545 §3.1: content lines are folded at 75 **octets**, not characters. */
const FOLD_OCTETS = 75;

export interface IcsEvent {
  uid: string;
  /** All-day date, `YYYY-MM-DD`. */
  date: string;
  summary: string;
  description: string;
  /** Days before `date` to raise a display alarm. */
  alarms: readonly number[];
  categories: readonly string[];
}

export interface IcsOptions {
  /** Epoch ms for DTSTAMP. Every VEVENT in one file shares it. */
  now: number;
  /** Shown as the calendar's name in Outlook. */
  name?: string;
  prodId?: string;
}

/* ----------------------------------------------------------- emitting -- */

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newlines are escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n?|\n/g, "\\n");
}

function octetLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Fold one content line.
 *
 * Split by code point, not by index: cutting a line in the middle of a
 * multi-byte character produces a file some parsers reject and others render as
 * mojibake, and the failure would only ever show up on a title with an accent.
 */
export function foldLine(line: string): string {
  if (octetLength(line) <= FOLD_OCTETS) return line;

  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  // Continuation lines start with a space, which itself costs an octet.
  let limit = FOLD_OCTETS;

  for (const char of line) {
    const size = octetLength(char);
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = FOLD_OCTETS - 1;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);

  return parts.join(`${CRLF} `);
}

/** `2026-09-15` → `20260915`, the DATE value type. */
export function toIcsDate(date: string): string {
  return date.replace(/-/g, "");
}

/** Epoch ms → `20260823T101500Z`, the UTC DATE-TIME form DTSTAMP requires. */
export function toIcsStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function addDaysTo(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

function alarmBlock(days: number, summary: string): string[] {
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    // A zero-day lead means "on the day"; RFC 5545 has no -P0D, so use PT0S.
    `TRIGGER:${days <= 0 ? "-PT0S" : `-P${days}D`}`,
    `DESCRIPTION:${escapeText(days <= 0 ? summary : `${summary} — in ${days} days`)}`,
    "END:VALARM",
  ];
}

export function buildCalendar(events: readonly IcsEvent[], options: IcsOptions): string {
  const stamp = toIcsStamp(options.now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.prodId ?? "-//SCDB Cockpit//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (options.name !== undefined && options.name !== "") {
    // Not standard, but it is what Outlook and Google read for a feed's name.
    lines.push(`X-WR-CALNAME:${escapeText(options.name)}`);
  }

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${toIcsDate(event.date)}`,
      // DTEND is exclusive for a DATE value, so a one-day event ends the day
      // after. Omitting it makes some clients render a zero-length event.
      `DTEND;VALUE=DATE:${addDaysTo(event.date, 1)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      // Free, not busy: these are deadlines, not appointments, and marking a
      // whole day busy would wreck the availability everyone else books into.
      "TRANSP:TRANSPARENT",
    );
    if (event.description !== "") lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.categories.length > 0) {
      lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
    }
    for (const days of event.alarms) lines.push(...alarmBlock(days, event.summary));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/* ------------------------------------------------------------ parsing -- */

export interface ParsedIcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm` when the entry had a time, else "". */
  startTime: string;
  endTime: string;
  allDay: boolean;
}

export interface CalendarParse {
  events: ParsedIcsEvent[];
  problems: string[];
}

function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const next = value[++i];
    out += next === "n" || next === "N" ? "\n" : (next ?? "");
  }
  return out;
}

/** Undo RFC 5545 folding: a line starting with space or tab continues the last. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
      continue;
    }
    lines.push(raw);
  }
  return lines;
}

/** `DTSTART;TZID=Europe/London:20260915T090000` → name, params, value. */
function splitLine(line: string): { name: string; params: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const semi = head.indexOf(";");
  return {
    name: (semi === -1 ? head : head.slice(0, semi)).trim().toUpperCase(),
    params: semi === -1 ? "" : head.slice(semi + 1).toUpperCase(),
    value: line.slice(colon + 1),
  };
}

const DATE_ONLY_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/;

/**
 * Read a DTSTART/DTEND value.
 *
 * A UTC (`Z`) value is **not** converted to local time. The alternative needs a
 * timezone database for `TZID` values we cannot resolve anyway, and a meeting
 * that lands in the vault an hour out is worse than one that reads exactly what
 * the file said. The imported note records what the calendar entry claimed.
 */
function readDateTime(value: string): { date: string; time: string } | null {
  const trimmed = value.trim();

  const dateOnly = DATE_ONLY_RE.exec(trimmed);
  if (dateOnly !== null) return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: "" };

  const dateTime = DATE_TIME_RE.exec(trimmed);
  if (dateTime !== null) {
    return {
      date: `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}`,
      time: `${dateTime[4]}:${dateTime[5]}`,
    };
  }
  return null;
}

/**
 * Parse the VEVENTs out of an `.ics` file.
 *
 * Everything else — VTODO, VJOURNAL, VFREEBUSY, VTIMEZONE, and the VALARMs
 * inside an event — is skipped rather than half-understood. An Outlook export
 * is mostly timezone definitions, and importing a VTIMEZONE as a meeting would
 * be a comic failure that only shows up once notes are already in the vault.
 */
export function parseCalendar(text: string): CalendarParse {
  const problems: string[] = [];
  const events: ParsedIcsEvent[] = [];

  let current: Partial<ParsedIcsEvent> | null = null;
  let depth = 0; // nesting inside a VEVENT (a VALARM, typically)
  let seenCalendar = false;

  for (const line of unfold(text)) {
    if (line.trim() === "") continue;
    const parsed = splitLine(line);
    if (parsed === null) continue;
    const { name, params, value } = parsed;

    if (name === "BEGIN" && value.trim().toUpperCase() === "VCALENDAR") {
      seenCalendar = true;
      continue;
    }
    if (name === "BEGIN") {
      const component = value.trim().toUpperCase();
      if (component === "VEVENT" && current === null) {
        current = { uid: "", summary: "", description: "", location: "", date: "", startTime: "", endTime: "" };
      } else if (current !== null) {
        depth += 1;
      }
      continue;
    }
    if (name === "END") {
      const component = value.trim().toUpperCase();
      if (component === "VEVENT" && current !== null && depth === 0) {
        finish(current, events, problems);
        current = null;
      } else if (current !== null && depth > 0) {
        depth -= 1;
      }
      continue;
    }

    // Properties inside a VALARM belong to the alarm, not to the event.
    if (current === null || depth > 0) continue;

    switch (name) {
      case "UID":
        current.uid = value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(value).trim();
        break;
      case "DESCRIPTION":
        current.description = unescapeText(value).trim();
        break;
      case "LOCATION":
        current.location = unescapeText(value).trim();
        break;
      case "DTSTART": {
        const when = readDateTime(value);
        if (when === null) break;
        current.date = when.date;
        current.startTime = when.time;
        current.allDay = params.includes("VALUE=DATE") || when.time === "";
        break;
      }
      case "DTEND": {
        const when = readDateTime(value);
        if (when !== null) current.endTime = when.time;
        break;
      }
      default:
        break;
    }
  }

  if (!seenCalendar) problems.push("This does not look like an iCalendar file — no BEGIN:VCALENDAR.");
  if (current !== null) problems.push("The last event in the file was never closed with END:VEVENT.");

  return { events, problems };
}

function finish(
  draft: Partial<ParsedIcsEvent>,
  events: ParsedIcsEvent[],
  problems: string[],
): void {
  if (draft.date === undefined || draft.date === "") {
    problems.push(
      `Skipped "${draft.summary === undefined || draft.summary === "" ? "an untitled entry" : draft.summary}" — no readable start date.`,
    );
    return;
  }
  events.push({
    uid: draft.uid ?? "",
    summary: draft.summary ?? "",
    description: draft.description ?? "",
    location: draft.location ?? "",
    date: draft.date,
    startTime: draft.startTime ?? "",
    endTime: draft.endTime ?? "",
    allDay: draft.allDay ?? true,
  });
}

/**
 * Free/busy words Outlook substitutes for a real title.
 *
 * Not a guess: in an "Availability only" export every `SUMMARY` is set to the
 * same word as `X-MICROSOFT-CDO-BUSYSTATUS`, and `DESCRIPTION`, `LOCATION`,
 * `ORGANIZER` and `ATTENDEE` are omitted entirely.
 */
const AVAILABILITY_WORDS = new Set([
  "busy",
  "free",
  "tentative",
  "private",
  "no title",
  "out of office",
  "working elsewhere",
]);

/**
 * True when a calendar file carries no real titles, only availability.
 *
 * Outlook's "Save Calendar" offers three detail levels, and the default —
 * **Availability only** — strips every title, description, location and
 * attendee, leaving each entry named after its free/busy status. Importing that
 * succeeds perfectly and produces a run of notes all called "Busy", which looks
 * exactly like a parser that lost the title. It is not: the title was never in
 * the file.
 *
 * Worth detecting rather than importing silently, because the fix is upstream
 * and thirty seconds long — re-export choosing **Full details** — while the
 * symptom sends someone hunting through a parser that is working correctly.
 * It reports; it never refuses. A calendar of genuinely private entries is a
 * real thing somebody may want in the vault.
 */
export function availabilityOnly(events: readonly ParsedIcsEvent[]): boolean {
  if (events.length === 0) return false;
  return events.every((event) => {
    const summary = event.summary.trim().toLowerCase();
    return summary === "" || AVAILABILITY_WORDS.has(summary);
  });
}
