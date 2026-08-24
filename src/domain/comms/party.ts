/**
 * Who a person is, across fields that spell them differently.
 *
 * The vault contract names the same human in several places — `blocked_on` and
 * `requester` on a request (§5.1), `with:` on a correspondence thread (§5.10),
 * `authors` on a publication (§5.4) — and this is a markdown vault, so all of
 * them are ordinary wikilinks a person typed. `[[Dr A Tan]]`,
 * `[[30 People/Dr A Tan]]` and `[[30 People/Dr A Tan|Tan]]` are the same
 * clinician and must group together, or the meeting agenda — the whole point of
 * which is "everything this one person is holding up" — quietly shows a third
 * of it.
 *
 * Deliberately *not* uid-based. §5.2 keeps machine references on `uid` and
 * human references on wikilinks, and a person note may not exist at all: an
 * approver can block a request before anyone has written them a note. Matching
 * on the written name is the honest reading of what the vault actually says,
 * and A4's integrity check is where a link with no note behind it gets raised.
 *
 * Pure module: no Obsidian, no Node.
 */

export interface Party {
  /** Exactly as written in the note, wikilink brackets and all. */
  raw: string;
  /** The link target with any folder path and alias removed: "Dr A Tan". */
  name: string;
  /** Case-folded `name`. Two fields naming one person share this. */
  key: string;
}

const WIKILINK = /^\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]$/;

/**
 * Read a person reference.
 *
 * A bare string that is not a wikilink is taken at face value — `blocked_on:
 * IT helpdesk` is a legitimate thing to write and grouping it with other
 * mentions of the same words is still useful.
 */
export function parseParty(value: string): Party {
  const raw = value.trim();
  const match = WIKILINK.exec(raw);
  const target = match ? match[1]!.trim() : raw;
  // The folder is where the note lives, not part of who the person is.
  const name = target.split("/").pop()?.trim() ?? target;
  return { raw, name, key: name.toLowerCase() };
}

/** Every party in a field that may hold one link, a list of them, or nothing. */
export function partiesIn(value: unknown): Party[] {
  const values = Array.isArray(value) ? value : [value];
  const parties: Party[] = [];
  const seen = new Set<string>();

  for (const entry of values) {
    if (typeof entry !== "string") continue;
    const party = parseParty(entry);
    if (party.key === "" || seen.has(party.key)) continue;
    seen.add(party.key);
    parties.push(party);
  }

  return parties;
}

/**
 * True when two references name the same thing.
 *
 * Not only people. A study is written exactly the same way — `[[EuroHeart]]` on
 * a request, `[[20 Studies/EuroHeart]]` on a publication, and bare `EuroHeart`
 * in the effort log, which is a plain-text table and not a note. B7's per-study
 * report has to treat all three as one study, or a chargeback statement quietly
 * omits every hour logged under the other spelling.
 */
export function sameParty(a: string, b: string): boolean {
  const key = parseParty(a).key;
  return key !== "" && key === parseParty(b).key;
}

/** True when two references name the same person. */
export function samePerson(a: string, b: string): boolean {
  return parseParty(a).key === parseParty(b).key;
}
