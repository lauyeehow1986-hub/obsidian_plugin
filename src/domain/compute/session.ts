/**
 * The wire between the plugin and a long-lived interpreter (§7 F2).
 *
 * §7 F2 names the mechanism — "fed through stdin, with sentinel markers
 * delimiting each execution so output can be attributed reliably" — and then
 * names where this kind of thing rots: "prompt detection, partial output,
 * encoding, and error recovery". Each of those is a decision here rather than
 * something to be discovered later.
 *
 * **No prompt detection.** Nothing in this module looks for `>` or `>>>`. A
 * prompt is a *display* convention: it moves with locale, it is absent under
 * `--vanilla`, R's continuation prompt is a different string, and a block that
 * prints `> ` would forge one. The harness instead announces the end of every
 * cell with a marker carrying a token generated for this session, so
 * attribution is something we arranged rather than something we inferred.
 *
 * **The token is not a security boundary and must not be described as one.**
 * Code running in the session can read its own command line and print a
 * perfect marker. What the token buys is that *accidental* collision is
 * impossible — a note about this plugin that quotes a marker cannot derail a
 * session. Code that forges one is already executing arbitrary instructions;
 * there is nothing left to protect at that point, which is exactly why rule 12
 * puts the defence at the moment a person decides to run something.
 *
 * **Both streams are marked, and a cell is over only when both have arrived.**
 * stdout and stderr are separate pipes with no ordering guarantee between
 * them. Ending a cell on the stdout marker alone loses the race whenever a
 * traceback is still in flight — the error would land in the *next* cell's
 * output, which is worse than no attribution at all.
 *
 * **Partial output is the parser's whole job.** Chunks arrive on OS timing, so
 * a marker can be split across two of them. Text is released as it arrives,
 * except for a tail that could still turn out to be the start of a marker.
 *
 * **A marker carries no newlines of its own, and that is a bug fix.** The
 * harness first wrote one before each marker so it would start a line, and the
 * parser took that newline back off as punctuation. It worked whenever the two
 * arrived in the same chunk — and when the boundary fell between them, the
 * newline was released as output and a blank line appeared before the result.
 * Intermittently, on OS chunking, which is the worst way to find anything. With
 * no newlines around a marker there is nothing positional left to get wrong:
 * the marker is removed wherever it falls and everything else is output. A test
 * pushes one through at every possible split to keep it that way.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { RunLanguage } from "./block";

/** Hex, generated per session by the service. Shape-checked, never trusted. */
export const TOKEN_PATTERN = /^[0-9a-f]{16}$/;

export function isSessionToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

const MARKER_START = "<<SCDB ";

/** What the host writes down stdin. ASCII only — see `cellFile` below. */
export function runCommand(cell: string): string {
  return `SCDB-RUN ${cell}\n`;
}

/** `0001`. Per session, monotonic; it never identifies anything outside one. */
export function cellId(sequence: number): string {
  return String(sequence).padStart(4, "0");
}

/**
 * The file a cell's code is written to.
 *
 * **User code never travels down stdin**, only this name does. That is the
 * same decision F1 made for the same two reasons: there is no escaping problem
 * to get wrong, and errors report the user's own line numbers. It buys a third
 * thing here — the protocol line is pure ASCII, so however Windows decides to
 * encode a pipe, the framing survives it. Encoding is then a question only
 * about the *file*, where both sides state UTF-8 explicitly.
 */
export function cellFile(language: RunLanguage, cell: string): string {
  return `cell-${cell}.${language === "r" ? "R" : "py"}`;
}

export type StreamName = "stdout" | "stderr";

export type SessionEvent =
  | { kind: "text"; stream: StreamName; text: string }
  /** stdout's marker: the cell ran, this is how it went. */
  | { kind: "end"; cell: string; status: number; figures: number }
  /** stderr's marker: nothing more is coming on stderr for this cell. */
  | { kind: "errEnd"; cell: string };

/**
 * Turns two byte streams into attributed events.
 *
 * One parser per session, holding a buffer per stream. It is deliberately not
 * told which cell is running: the marker says which cell it belongs to, so a
 * host that fell behind still attributes correctly rather than confidently
 * mislabelling.
 */
export class SessionParser {
  private readonly buffers: Record<StreamName, string> = { stdout: "", stderr: "" };
  private readonly end: RegExp;
  private readonly err: RegExp;

  constructor(token: string) {
    // The token is hex, so it needs no escaping — asserted rather than assumed,
    // because a regex built from an unchecked string is how injection happens.
    if (!isSessionToken(token)) throw new Error("A session token must be 16 hex characters.");
    this.end = new RegExp(`${MARKER_START}${token} END (\\d{4}) (-?\\d+) (\\d+)>>`);
    this.err = new RegExp(`${MARKER_START}${token} ERR (\\d{4})>>`);
  }

  push(stream: StreamName, chunk: string): SessionEvent[] {
    this.buffers[stream] += chunk;
    return this.drain(stream, false);
  }

  /**
   * Release everything held back.
   *
   * Called when the process ends. Whatever was being held as a possible marker
   * is not one — the process is gone and no completion is coming — so it is
   * output, and output is never silently dropped.
   */
  flush(stream: StreamName): SessionEvent[] {
    return this.drain(stream, true);
  }

  private drain(stream: StreamName, final: boolean): SessionEvent[] {
    const events: SessionEvent[] = [];

    for (;;) {
      const buffer = this.buffers[stream];
      const match = stream === "stdout" ? this.end.exec(buffer) : this.err.exec(buffer);
      if (match === null || match.index === undefined) break;

      const before = buffer.slice(0, match.index);
      if (before !== "") events.push({ kind: "text", stream, text: before });

      if (stream === "stdout") {
        events.push({
          kind: "end",
          cell: match[1] ?? "",
          status: Number(match[2] ?? "0"),
          figures: Number(match[3] ?? "0"),
        });
      } else {
        events.push({ kind: "errEnd", cell: match[1] ?? "" });
      }

      this.buffers[stream] = buffer.slice(match.index + match[0].length);
    }

    const rest = this.buffers[stream];
    const hold = final ? rest.length : rest.length - heldBack(rest);
    if (hold > 0) {
      events.push({ kind: "text", stream, text: rest.slice(0, hold) });
    }
    this.buffers[stream] = rest.slice(hold);

    return events;
  }
}

/**
 * How many characters at the end of a buffer might still become a marker.
 *
 * Two cases, and missing either one puts half a marker in the console:
 *
 *  - a complete `<<SCDB ` with no closing `>>` yet — the middle of a marker;
 *  - a *prefix* of `<<SCDB ` at the very end — `<<S`, arriving on its own.
 *
 * Anything else is output and goes straight through, which is what makes a
 * long-running loop print as it goes rather than all at once at the end.
 */
export function heldBack(rest: string): number {
  const started = rest.lastIndexOf(MARKER_START);
  if (started >= 0 && !rest.slice(started).includes(">>")) return rest.length - started;

  for (let length = Math.min(MARKER_START.length - 1, rest.length); length > 0; length -= 1) {
    if (MARKER_START.startsWith(rest.slice(rest.length - length))) return length;
  }
  return 0;
}

/**
 * One row of the environment pane.
 *
 * Reported through a file rather than through the streams. The console is
 * something a person reads, and a listing of every variable after every cell
 * would bury the output that was the point of running it — and it would have
 * to be escaped out of the stream on the way past.
 */
export interface EnvEntry {
  name: string;
  /** The interpreter's own word for it: `data.frame`, `list`, `ndarray`. */
  kind: string;
  /** Length, or dimensions as `3x2`. Empty where neither means anything. */
  size: string;
  /** A short, already-truncated description. Never the whole value. */
  summary: string;
}

/**
 * Tab-separated, not JSON, and that is a base-R constraint rather than a taste.
 *
 * R has no JSON writer in base — `jsonlite` is a package, and §7 F1's whole
 * argument for `--vanilla` is that we do not get to assume what is installed
 * on the target machine. Tabs are written by both harnesses and stripped from
 * every field before writing, so the format cannot be broken by a value.
 */
export function parseEnvironment(text: string): EnvEntry[] {
  const rows: EnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const name = parts[0] ?? "";
    if (name === "") continue;
    rows.push({
      name,
      kind: parts[1] ?? "",
      size: parts[2] ?? "",
      summary: parts[3] ?? "",
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}
