/**
 * Building the URIs that hand a draft to Outlook or Teams (CLAUDE.md §5.11).
 *
 * **The plugin composes; it never sends.** Nothing here talks to a network, a
 * mailbox or an API. It produces a string that the OS shell hands to whatever
 * is registered for the scheme, and the user presses send themselves.
 *
 * That modest job carries the sharpest security edge in the plugin, because the
 * inputs are note fields and a note may have been pasted out of an email. Every
 * rule below traces to a named failure:
 *
 *  - A CR or LF in an address field **injects extra mailto headers**.
 *    `a@b.com%0D%0Abcc:attacker@example.com` silently adds a blind copy of a
 *    chase-up about a clinical data request. §5.11 rule 3 is explicit that
 *    encoding the body is not sufficient and that such an address is *rejected*,
 *    not escaped — an address we cannot vouch for is not an address.
 *  - Handlers truncate somewhere around 2,000 characters and the limit varies
 *    by handler and by Windows build. §5.11 rule 1: measure the built URI and
 *    refuse to launch a truncated draft. A chase-up email that arrives with the
 *    ask cut off is a real-world failure, not a cosmetic one.
 *  - `shell.openExternal` will start **any** registered protocol handler, so
 *    rule 4 requires an allowlist checked on the built string, after building,
 *    never on the parts that went into it.
 *
 * Pure module: no Obsidian, no Node, no I/O.
 */

/* ------------------------------------------------------------ addresses -- */

/**
 * Characters that end the argument here rather than being escaped.
 *
 * CR and LF are the header-injection vector. A comma or semicolon separates
 * recipients in a mailto, so one inside a single address silently becomes two.
 * The rest are quoting and routing characters that have no business in an
 * address we generated from a note.
 */
const FORBIDDEN_IN_ADDRESS = /[\r\n\t,;<>"'\\ ]/;

/** Anything outside printable ASCII: control characters and non-ASCII alike. */
const OUTSIDE_PRINTABLE_ASCII = /[^ -~]/;

const LOCAL_PART = /^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Why an address was refused, in words a person can act on — or null if it is
 * usable. Shape is validated *before* the URI is built (§5.11 rule 3).
 */
export function addressProblem(value: string): string | null {
  const address = value.trim();
  if (address === "") return "is empty";

  if (/[\r\n]/.test(address)) {
    // Named separately from the rest: this is the one that would have changed
    // who received the message, so the message says so.
    return "contains a line break, which would let it add extra recipients or headers";
  }
  if (FORBIDDEN_IN_ADDRESS.test(address)) {
    return "contains a character that is not allowed in an address (a comma, quote, bracket or space)";
  }
  if (OUTSIDE_PRINTABLE_ASCII.test(address)) {
    return "contains a control or non-ASCII character; internationalised addresses are not supported";
  }

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return "is not of the form name@domain";

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (local.includes("@")) return "has more than one @";
  if (!LOCAL_PART.test(local)) return "has a part before the @ that is not a valid address";

  const labels = domain.split(".");
  if (labels.length < 2) return "has a domain with no dot in it";
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return "has a domain that is not valid";

  return null;
}

export interface AddressCheck {
  /** Addresses that passed, de-duplicated, in the order first seen. */
  usable: string[];
  /** One line per rejected address, already phrased for a notice. */
  refused: string[];
}

/** Validate a recipient list, keeping what is usable and saying what is not. */
export function checkAddresses(values: readonly string[], field: string): AddressCheck {
  const usable: string[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const problem = addressProblem(value);
    if (problem !== null) {
      // The address is echoed because the user has to find it in a note to fix
      // it. It is an address, not clinical content — rule 7 is not in play.
      refused.push(`${field} "${value.trim()}" ${problem}.`);
      continue;
    }
    const address = value.trim();
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(address);
  }

  return { usable, refused };
}

/* -------------------------------------------------------------- encoding -- */

/**
 * Percent-encode one component, with two adjustments for mail clients.
 *
 * Line breaks become CRLF first: §5.11 asks for `%0D%0A`, and a lone `%0A`
 * lands as a literal in some Outlook builds instead of a new line. `@` is put
 * back because it is legal unencoded in a mailto and `%40` in a visible address
 * looks like a fault to the person reading the draft.
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value.replace(/\r\n|\r|\n/g, "\r\n")).replace(/%40/g, "@");
}

/* --------------------------------------------------------------- drafts -- */

export interface EmailDraft {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  /** Plain text. No attachments — a mailto cannot carry one (§5.11). */
  body: string;
}

export interface TeamsDraft {
  /** User principal names. Same shape and same validation as an address. */
  users: readonly string[];
  message: string;
}

/** A URI we built, ready for the allowlist check and the length guard. */
export interface ComposedUri {
  uri: string;
  /** Characters, not bytes: what handlers actually count. */
  length: number;
}

export type ComposeResult = { ok: true; uri: ComposedUri } | { ok: false; problems: string[] };

/** `mailto:` with to, cc, subject and body. Rejects rather than escapes (rule 3). */
export function buildMailto(draft: EmailDraft): ComposeResult {
  const to = checkAddresses(draft.to, "Recipient");
  const cc = checkAddresses(draft.cc ?? [], "Cc");
  const problems = [...to.refused, ...cc.refused];

  if (to.usable.length === 0) {
    problems.push("There is nobody to send this to.");
  }
  if (problems.length > 0) return { ok: false, problems };

  const query: string[] = [];
  if (cc.usable.length > 0) query.push(`cc=${encodeComponent(cc.usable.join(","))}`);
  if (draft.subject.trim() !== "") query.push(`subject=${encodeComponent(draft.subject)}`);
  if (draft.body !== "") query.push(`body=${encodeComponent(draft.body)}`);

  const uri =
    `mailto:${encodeComponent(to.usable.join(","))}` +
    (query.length > 0 ? `?${query.join("&")}` : "");

  return { ok: true, uri: { uri, length: uri.length } };
}

/** The one https host this plugin ever opens. Constant, never taken from a note. */
export const TEAMS_HOST = "teams.microsoft.com";

/**
 * A Teams deep link that opens a chat pre-filled.
 *
 * The `https:` form is used rather than `msteams:` because it works whether or
 * not the desktop client is installed, and because §5.11 rule 4's allowlist has
 * to hold for whatever we produce — an https URL to a host we hardcode is
 * easier to reason about than a custom scheme.
 */
export function buildTeamsChat(draft: TeamsDraft): ComposeResult {
  const users = checkAddresses(draft.users, "Teams user");
  if (users.refused.length > 0) return { ok: false, problems: users.refused };
  if (users.usable.length === 0) {
    return { ok: false, problems: ["There is nobody to send this to."] };
  }

  const uri =
    `https://${TEAMS_HOST}/l/chat/0/0` +
    `?users=${encodeComponent(users.usable.join(","))}` +
    `&message=${encodeComponent(draft.message)}`;

  return { ok: true, uri: { uri, length: uri.length } };
}

/* ------------------------------------------------------------ guardrails -- */

/**
 * The only schemes this plugin may hand to the OS (§5.11 rule 4).
 *
 * Checked on the built string immediately before launching, never on the parts.
 * A URL that came out of note content does not go through here at all — it is
 * not opened.
 */
export const ALLOWED_SCHEMES = ["mailto:", "https:", "msteams:"] as const;

export function schemeAllowed(uri: string): boolean {
  const lower = uri.toLowerCase();
  if (!ALLOWED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;
  // An https URL we built always points at the one host above. Anything else
  // reaching this function is not ours, whatever its scheme says.
  if (lower.startsWith("https:")) return lower.startsWith(`https://${TEAMS_HOST}/`);
  return true;
}

/** Below this a ceiling is not a safety margin, it is a way to compose nothing. */
export const MIN_URI_CEILING = 200;

/**
 * Default ceiling, deliberately under the ~2,000 where handlers start to cut.
 *
 * It is a setting because the real figure varies by handler and by Windows
 * build, and §11 lists measuring it on the target machine as an open question.
 * Until that is answered, err low: a message that goes to the clipboard is an
 * inconvenience, a message that arrives truncated is a mistake in front of a
 * clinician.
 */
export const DEFAULT_URI_CEILING = 1800;

export type Delivery = "launch" | "clipboard";

/**
 * Whether this URI can be launched, or has to go to the clipboard instead.
 *
 * Never "launch it truncated" (§5.11 rule 1), and clipboard is an equal
 * alternative the user may pick outright, not only a fallback (rule 2).
 */
export function deliveryFor(uri: ComposedUri, ceiling: number): Delivery {
  const limit = Math.max(MIN_URI_CEILING, Math.floor(ceiling));
  return uri.length <= limit ? "launch" : "clipboard";
}

/** Why the draft went to the clipboard, in words, with the numbers that decided it. */
export function tooLongMessage(uri: ComposedUri, ceiling: number): string {
  const limit = Math.max(MIN_URI_CEILING, Math.floor(ceiling));
  return (
    `The draft is ${uri.length} characters and the limit is ${limit}, so opening it ` +
    `would risk the end being cut off. It is on the clipboard instead — paste it ` +
    `into a new message.`
  );
}
