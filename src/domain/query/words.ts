/**
 * Text mechanics for the English-language search (CLAUDE.md §7 B4).
 *
 * Nothing here knows what a query is. It turns typed text into tokens that
 * remember where they came from — so a chip can point at the exact words that
 * produced it and removing the chip can delete exactly those words — and it
 * reads the several ways English writes a quantity ("2 weeks", "a fortnight",
 * "10 days").
 *
 * Both sides of every comparison go through the same tokeniser, so a stage id
 * (`awaiting-approval`), its label (`Awaiting approval`) and what someone types
 * (`awaiting approval`) all reduce to the same two words. That is the whole
 * trick: the vocabulary comes from the vault, not from a list in the code.
 *
 * Pure module: no Obsidian, no Node.
 */

export interface Token {
  /** Lower-cased. Words, numbers and comparison symbols; nothing else. */
  norm: string;
  /** Offsets into the original string, so a chip can quote or delete itself. */
  start: number;
  end: number;
}

/**
 * Words, numbers and the four comparison symbols.
 *
 * Everything else — punctuation, quotes, hyphens — is a separator rather than
 * part of a token, which is what makes `awaiting-approval` and `awaiting
 * approval` the same phrase.
 */
const TOKEN = /\d+(?:\.\d+)?|[\p{L}]+|>=|<=|>|</giu;

export function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const value = match[0];
    tokens.push({
      norm: value.toLowerCase(),
      start: match.index,
      end: match.index + value.length,
    });
  }
  return tokens;
}

/** A vocabulary phrase reduced to the same words the tokeniser produces. */
export function wordsOf(phrase: string): string[] {
  return tokenise(phrase).map((token) => token.norm);
}

/** True when `words` appears at `at`, in order. An empty phrase never matches. */
export function matchAt(tokens: readonly Token[], at: number, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  return words.every((word, offset) => tokens[at + offset]?.norm === word);
}

/** The original text a run of tokens covers, for quoting back in a chip. */
export function spanText(text: string, tokens: readonly Token[], at: number, length: number): string {
  const first = tokens[at];
  const last = tokens[at + length - 1];
  if (!first || !last) return "";
  return text.slice(first.start, last.end);
}

/* ------------------------------------------------------------ quantities -- */

/** Small numbers get written out, and a chase-up is never about 47 of anything. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Units, in days.
 *
 * A month is 30 days and a year 365 here, which is wrong as a calendar and
 * right as a duration: "sat there more than three months" is a rough statement
 * and the chip says how it was read, so nobody has to guess. Date *windows*
 * (§B4 `dateRule`) do their own arithmetic and do not use this.
 */
const UNIT_DAYS: Record<string, number> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  fortnight: 14,
  fortnights: 14,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};

export interface Quantity {
  days: number;
  /** How it was written, for the chip label. */
  text: string;
  /** Tokens consumed. */
  length: number;
}

/** "2 weeks", "a fortnight", "10 days", "fortnight". Null when it is not one. */
export function parseQuantity(tokens: readonly Token[], at: number): Quantity | null {
  const first = tokens[at];
  if (!first) return null;

  const digits = /^\d+(?:\.\d+)?$/.test(first.norm) ? Number(first.norm) : null;
  const spelled = NUMBER_WORDS[first.norm];
  const count = digits ?? spelled ?? null;

  // A bare unit means one of it: "in triage a fortnight".
  const unitAt = count === null ? at : at + 1;
  const unitWord = tokens[unitAt]?.norm ?? "";
  const perUnit = UNIT_DAYS[unitWord];
  if (perUnit === undefined) return null;

  const amount = count ?? 1;
  const length = unitAt - at + 1;
  return {
    days: amount * perUnit,
    text: count === null ? `a ${unitWord}` : `${amount} ${unitWord}`,
    length,
  };
}

/** A plain count: "top 10", "first five". */
export function parseCount(tokens: readonly Token[], at: number): { count: number; length: number } | null {
  const token = tokens[at];
  if (!token) return null;
  if (/^\d+$/.test(token.norm)) return { count: Number(token.norm), length: 1 };
  const spelled = NUMBER_WORDS[token.norm];
  return spelled === undefined ? null : { count: spelled, length: 1 };
}

/** Days as the operand a duration filter takes (`14d`), per `evaluate.ts`. */
export function durationOperand(days: number): string {
  return `${days}d`;
}

/** Days as the operand a date filter takes (`+7d`), per `evaluate.ts`. */
export function dateOperand(days: number): string {
  if (days === 0) return "today";
  return days > 0 ? `+${days}d` : `${days}d`;
}

/* --------------------------------------------------------- phrase lookup -- */

interface Entry<T> {
  words: string[];
  /** Null once two different things answered to the same words. */
  value: T | null;
}

/**
 * Longest-match lookup for multi-word phrases, keyed on the first word.
 *
 * Ambiguity is refused rather than resolved. If two stages, two people or two
 * fields answer to the same words, the phrase stops matching anything and the
 * words are reported as not understood — a search that silently picks one of
 * two people is worse than one that says it could not tell them apart.
 */
export class PhraseIndex<T> {
  private byFirst = new Map<string, Entry<T>[]>();

  add(words: readonly string[], value: T): void {
    const first = words[0];
    if (first === undefined) return;
    const bucket = this.byFirst.get(first) ?? [];
    const existing = bucket.find((entry) => entry.words.join(" ") === words.join(" "));
    if (existing) {
      if (existing.value !== value) existing.value = null;
      return;
    }
    bucket.push({ words: [...words], value });
    this.byFirst.set(first, bucket);
  }

  /** The longest unambiguous phrase starting at `at`. */
  match(tokens: readonly Token[], at: number): { value: T; length: number } | null {
    const first = tokens[at]?.norm;
    if (first === undefined) return null;
    let best: { value: T; length: number } | null = null;
    for (const entry of this.byFirst.get(first) ?? []) {
      if (entry.value === null) continue;
      if (!matchAt(tokens, at, entry.words)) continue;
      if (best === null || entry.words.length > best.length) {
        best = { value: entry.value, length: entry.words.length };
      }
    }
    return best;
  }
}
