/**
 * The scanner's working state and the shape of a grammar rule (§7 B4).
 *
 * A rule looks at one position in the token stream and either claims a run of
 * tokens or declines. Rules never mutate anything: they return what they
 * matched, including any anchor they want a later rule to inherit, and the
 * scanner in `language.ts` decides which of them won.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { ChipBody } from "./chips";
import type { FieldDef } from "./model";
import type { Context } from "./context";
import type { Token } from "./words";

/* ------------------------------------------------------------- scanning -- */

export interface Scan {
  text: string;
  tokens: Token[];
  ctx: Context;
  /** Set by a phrase like "stuck in triage", used by a later bare quantity. */
  duration: string | null;
  date: string | null;
}

export interface Match {
  length: number;
  bodies: ChipBody[];
  duration?: string;
  date?: string;
  negate?: boolean;
}

export type Rule = (scan: Scan, at: number) => Match | null;

export function word(scan: Scan, at: number): string {
  return scan.tokens[at]?.norm ?? "";
}

export function kindOf(scan: Scan, field: string): FieldDef["kind"] | null {
  return scan.ctx.fields.get(field)?.kind ?? null;
}

export function labelOf(scan: Scan, field: string): string {
  return scan.ctx.fields.get(field)?.label ?? field;
}

/** A field named by synonym, then by label, then by id — in that precedence. */
export function matchField(scan: Scan, at: number): { field: string; length: number } | null {
  for (const index of [scan.ctx.synonyms, scan.ctx.labels, scan.ctx.ids]) {
    const hit = index.match(scan.tokens, at);
    if (hit) return { field: hit.value, length: hit.length };
  }
  return null;
}

export function skipWhile(scan: Scan, at: number, test: (norm: string) => boolean): number {
  let index = at;
  while (index < scan.tokens.length && test(word(scan, index))) index += 1;
  return index;
}
