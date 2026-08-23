/**
 * English-language search (CLAUDE.md §7 B4).
 *
 * *"requests stuck in approval more than 2 weeks for Dr Tan"* becomes an
 * ordinary A2 query. Nothing is inferred by a model and nothing leaves the
 * machine: the vocabulary is the vault's own — the workflow's stage names, the
 * catalogue's field labels, the people and studies that actually appear in
 * frontmatter — plus the phrase tables in `phrases.ts`.
 *
 * Two design rules, both from B4 and rule 5:
 *
 * 1. **Every understood phrase becomes a chip** carrying the exact characters
 *    it came from. The chips are the audit trail, and because they know their
 *    own span, deleting a chip can delete precisely those words — so what is
 *    shown and what is typed can never drift apart.
 * 2. **Anything not understood is reported, never guessed.** An ambiguous name
 *    matches nothing rather than picking a person. A search that quietly
 *    dropped half the sentence is how someone chases the wrong clinician.
 *
 * This module is the scanner: longest-match-wins, left to right, with rule
 * order breaking ties — so "stuck in approval" reads as a stage rather than as
 * the word "stuck" followed by rubbish. The grammar itself lives in `rules.ts`
 * and `shaping.ts`, the vocabulary in `phrases.ts`, and what a match becomes
 * in `chips.ts`.
 *
 * Pure module: no Obsidian, no Node.
 */

import { buildContext } from "./context";
import { negateBody, type Chip, type ParsedText, type Vocabulary } from "./chips";
import {
  ruleAnchor,
  ruleDateWindow,
  ruleDuration,
  ruleFiller,
  ruleNegator,
  ruleStage,
  ruleStatus,
  ruleType,
  ruleValue,
} from "./rules";
import { ruleAggregate, ruleGroup, ruleLimit, ruleSort } from "./shaping";
import type { Match, Rule, Scan } from "./scan";
import { tokenise } from "./words";

export {
  chipsToQuery,
  emptyVocabulary,
  textWithoutChip,
  type Chip,
  type ChipBody,
  type ChipPlace,
  type ParsedText,
  type Vocabulary,
} from "./chips";

/** Order breaks ties; length wins outright. */
const RULES: readonly Rule[] = [
  ruleLimit,
  ruleDuration,
  ruleDateWindow,
  ruleStatus,
  // Sort before aggregate: "longest waiting" is a way to order a board far
  // more often than it is a request for the maximum dwell time.
  ruleSort,
  ruleAggregate,
  ruleGroup,
  ruleStage,
  ruleValue,
  ruleType,
  ruleAnchor,
  ruleNegator,
  ruleFiller,
];

function bestMatch(scan: Scan, at: number): Match | null {
  let best: Match | null = null;
  for (const rule of RULES) {
    const match = rule(scan, at);
    if (match !== null && (best === null || match.length > best.length)) best = match;
  }
  return best;
}

export function parseQueryText(text: string, vocab: Vocabulary): ParsedText {
  const tokens = tokenise(text);
  // The box is re-parsed on every keystroke, and an empty one is the common
  // case; building the phrase indexes for it would be pure waste.
  if (tokens.length === 0) return { chips: [], ignored: [] };

  const scan: Scan = {
    text,
    tokens,
    ctx: buildContext(vocab),
    duration: null,
    date: null,
  };

  const chips: Chip[] = [];
  const ignored: string[] = [];
  let run: { start: number; end: number } | null = null;
  let negateFrom: number | null = null;
  let serial = 0;
  let at = 0;

  const flush = (): void => {
    if (run === null) return;
    const words = text.slice(run.start, run.end).trim();
    if (words !== "") ignored.push(words);
    run = null;
  };

  while (at < scan.tokens.length) {
    const match = bestMatch(scan, at);
    const token = scan.tokens[at];
    if (match === null || token === undefined) {
      if (token !== undefined) {
        run = run === null ? { start: token.start, end: token.end } : { start: run.start, end: token.end };
      }
      at += 1;
      continue;
    }
    flush();

    if (match.duration !== undefined) scan.duration = match.duration;
    if (match.date !== undefined) scan.date = match.date;
    if (match.negate === true) {
      negateFrom = negateFrom ?? at;
      at += match.length;
      continue;
    }

    const from = negateFrom ?? at;
    const first = scan.tokens[from];
    const last = scan.tokens[at + match.length - 1];
    for (const body of match.bodies) {
      serial += 1;
      chips.push({
        ...(negateFrom === null ? body : negateBody(body)),
        id: `chip-${serial}`,
        start: first?.start ?? 0,
        end: last?.end ?? 0,
        source: text.slice(first?.start ?? 0, last?.end ?? 0),
      });
    }
    if (match.bodies.length > 0) negateFrom = null;
    at += match.length;
  }
  flush();

  return { chips, ignored };
}
