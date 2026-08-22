/**
 * Quick capture (CLAUDE.md §7 B1, §5.14).
 *
 * One hotkey, one line, straight into `00 Inbox/`. **Never blocks, never asks a
 * second question.** That is the entire specification and it is a hard one:
 * every field this could usefully ask for — which request, which study, how
 * long you think it will take — is a field that turns a two-second capture into
 * a ten-second decision, and a capture tool with a ten-second cost does not get
 * used while somebody is standing in your doorway.
 *
 * So the note is deliberately thin. The current mode is recorded because it is
 * free — the plugin already knows which hat you are wearing — and because it is
 * the one piece of context that is genuinely gone by the time you triage.
 *
 * Pure module: no Obsidian, no Node. The caller supplies the taken filenames.
 */

import { ulid } from "../id/ulid";
import { toVaultDate, toVaultMinute } from "../time/dates";

export const CAPTURE_TYPE = "capture";

/** Characters Windows and Obsidian both refuse in a filename. */
const UNSAFE_IN_FILENAME = /[\\/:*?"<>|#^[\]]/g;

/**
 * A filename stem from the captured text.
 *
 * Date first so the inbox sorts chronologically, then enough of the text to be
 * recognisable in a file list. Capped well short of any path limit: the vault
 * may sit under a deep OneDrive path on a managed laptop, and a capture that
 * fails to save is the one failure this feature cannot have.
 */
export function captureStem(text: string, now: number): string {
  const words = text
    .replace(UNSAFE_IN_FILENAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim()
    // A trailing dot makes a filename Windows will not create.
    .replace(/\.+$/, "")
    .trim();

  const stamp = `${toVaultDate(now)} ${toVaultMinute(now).slice(11).replace(":", "")}`;
  return words === "" ? stamp : `${stamp} ${words}`;
}

/**
 * The first free filename, suffixing rather than overwriting.
 *
 * Two captures in the same minute with the same opening words is unlikely and
 * entirely possible, and rule 8 says never destroy data you did not write —
 * including data you wrote forty seconds ago.
 */
export function freeFilename(stem: string, taken: ReadonlySet<string>): string {
  if (!taken.has(`${stem}.md`)) return `${stem}.md`;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  // Falls back to something that cannot collide rather than failing the capture.
  return `${stem} ${ulid(Date.now())}.md`;
}

export interface CaptureInput {
  text: string;
  now: number;
  mode: string;
  /** Filenames already in the inbox folder, extension included. */
  taken?: ReadonlySet<string>;
  /** Defaults to a fresh ULID; injectable so tests are deterministic. */
  uid?: string;
}

export interface Capture {
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function newCapture(input: CaptureInput): Capture {
  const text = input.text.trim();
  if (text === "") throw new Error("There is nothing to capture.");

  return {
    filename: freeFilename(captureStem(text, input.now), input.taken ?? new Set()),
    frontmatter: {
      type: CAPTURE_TYPE,
      uid: input.uid ?? ulid(input.now),
      captured: toVaultMinute(input.now),
      // The hat you were wearing. Free to record now, gone by triage time.
      mode: input.mode,
      // Explicitly false rather than absent, so "what is still untriaged" is a
      // question the index can answer without inferring from a missing key.
      triaged: false,
    },
    // The captured line is the body, verbatim and unparsed. Nothing here tries
    // to read a date or a request id out of it — B6 does deterministic
    // extraction, and guessing at capture time would put a wrong link in a note
    // the user never opened.
    body: `${text}\n`,
  };
}
