/**
 * Turning a vocabulary into something the scanner can look words up in (§7 B4).
 *
 * One `Context` per parse: a phrase index per kind of thing the grammar can
 * recognise. Building them here rather than in the rules keeps the grammar
 * readable, and puts every ambiguity decision — an alias two people answer to,
 * a stage word two stages share — in one place, where it is refused rather
 * than resolved.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  COMPARATORS,
  DATE_ANCHORS,
  DATE_COMPARATORS,
  DATE_WINDOWS,
  DURATION_ANCHORS,
  FIELD_SYNONYMS,
  FILLER,
  GLUE,
  NEGATORS,
  SORT_PHRASES,
  STATUS_PHRASES,
  TYPE_WORDS,
  VALUE_BINDINGS,
  type StatusPhrase,
} from "./phrases";
import type { AggregateFn, FieldDef, Operator } from "./model";
import { PhraseIndex, wordsOf } from "./words";
import type { Vocabulary } from "./chips";

/* -------------------------------------------------------------- context -- */

export interface ValueMatch {
  value: string;
  /** Fields this value actually appears in. */
  fields: string[];
}

export interface AnchorMatch {
  field: string;
  op?: "gt" | "lt";
}

export interface DateWindow {
  from: number;
  to: number;
  label: string;
}

export interface Context {
  fields: Map<string, FieldDef>;
  synonyms: PhraseIndex<string>;
  labels: PhraseIndex<string>;
  ids: PhraseIndex<string>;
  stages: PhraseIndex<{ id: string; label: string }>;
  values: PhraseIndex<ValueMatch>;
  types: PhraseIndex<string>;
  comparators: PhraseIndex<Operator>;
  dateComparators: PhraseIndex<Operator>;
  durationAnchors: PhraseIndex<AnchorMatch>;
  dateAnchors: PhraseIndex<string>;
  bindings: PhraseIndex<string>;
  statuses: PhraseIndex<StatusPhrase>;
  sorts: PhraseIndex<(typeof SORT_PHRASES)[number]>;
  windows: PhraseIndex<DateWindow>;
  aggregates: PhraseIndex<AggregateFn>;
}

/** Honorifics, so "Dr A Tan" also answers to "Tan" and "Dr Tan". */
const HONORIFICS = new Set(["dr", "prof", "professor", "mr", "mrs", "ms", "miss", "sir", "dame"]);

/**
 * Single words too common to be a name or a stage on their own.
 *
 * Without this a stage called `on-hold` would let "on" mean a stage, and
 * "requests on EuroHeart" would filter the queue to everything paused.
 */
function stopWords(): Set<string> {
  const stop = new Set<string>([...FILLER, ...NEGATORS, ...GLUE]);
  for (const table of [COMPARATORS, DATE_COMPARATORS, VALUE_BINDINGS]) {
    for (const entry of table) {
      const words = wordsOf(entry.phrase);
      if (words.length === 1 && words[0] !== undefined) stop.add(words[0]);
    }
  }
  return stop;
}

function nameAliases(value: string): string[][] {
  const words = wordsOf(value);
  if (words.length === 0) return [];
  const aliases: string[][] = [words];
  const last = words[words.length - 1];
  if (words.length > 1 && last !== undefined) {
    aliases.push([last]);
    if (words[0] !== undefined && HONORIFICS.has(words[0])) {
      aliases.push([words[0], last]);
      aliases.push(words.slice(1));
    }
  }
  return aliases;
}

export function buildContext(vocab: Vocabulary): Context {
  const stop = stopWords();
  const ctx: Context = {
    fields: new Map(vocab.fields.map((field) => [field.id, field])),
    synonyms: new PhraseIndex(),
    labels: new PhraseIndex(),
    ids: new PhraseIndex(),
    stages: new PhraseIndex(),
    values: new PhraseIndex(),
    types: new PhraseIndex(),
    comparators: new PhraseIndex(),
    dateComparators: new PhraseIndex(),
    durationAnchors: new PhraseIndex(),
    dateAnchors: new PhraseIndex(),
    bindings: new PhraseIndex(),
    statuses: new PhraseIndex(),
    sorts: new PhraseIndex(),
    windows: new PhraseIndex(),
    aggregates: new PhraseIndex(),
  };

  for (const field of vocab.fields) {
    ctx.labels.add(wordsOf(field.label), field.id);
    ctx.ids.add(wordsOf(field.id), field.id);
    for (const synonym of FIELD_SYNONYMS[field.id] ?? []) ctx.synonyms.add(wordsOf(synonym), field.id);
  }

  for (const stage of vocab.stages) {
    for (const phrase of [stage.label, stage.id]) {
      const words = wordsOf(phrase);
      ctx.stages.add(words, stage);
      // A single distinctive word is how people actually refer to a stage
      // ("approval", "extraction"). Two stages sharing one makes it ambiguous,
      // and `PhraseIndex` then refuses it.
      for (const word of words) {
        if (words.length > 1 && !stop.has(word)) ctx.stages.add([word], stage);
      }
    }
  }

  // Names, gathered from the values that actually appear in the vault. Built
  // in two passes so an alias claimed by two different people is dropped
  // rather than resolved to whichever was indexed first.
  const byAlias = new Map<string, { words: string[]; values: Set<string>; fields: Set<string> }>();
  for (const [field, values] of Object.entries(vocab.values)) {
    if (!ctx.fields.has(field)) continue;
    for (const value of values) {
      for (const alias of nameAliases(value)) {
        if (alias.length === 1 && (alias[0] === undefined || stop.has(alias[0]))) continue;
        const key = alias.join(" ");
        const entry = byAlias.get(key) ?? { words: alias, values: new Set(), fields: new Set() };
        entry.values.add(value);
        entry.fields.add(field);
        byAlias.set(key, entry);
      }
    }
  }
  for (const entry of byAlias.values()) {
    const [only] = [...entry.values];
    if (entry.values.size !== 1 || only === undefined) continue;
    ctx.values.add(entry.words, { value: only, fields: [...entry.fields] });
  }

  for (const type of vocab.types) {
    ctx.types.add(wordsOf(type), type);
    for (const word of TYPE_WORDS[type] ?? []) ctx.types.add(wordsOf(word), type);
  }

  for (const entry of COMPARATORS) ctx.comparators.add(wordsOf(entry.phrase), entry.op);
  for (const entry of DATE_COMPARATORS) ctx.dateComparators.add(wordsOf(entry.phrase), entry.op);
  for (const entry of DURATION_ANCHORS) {
    ctx.durationAnchors.add(
      wordsOf(entry.phrase),
      entry.op === undefined ? { field: entry.field } : { field: entry.field, op: entry.op },
    );
  }
  for (const entry of DATE_ANCHORS) ctx.dateAnchors.add(wordsOf(entry.phrase), entry.field);
  for (const entry of VALUE_BINDINGS) ctx.bindings.add(wordsOf(entry.phrase), entry.field);
  for (const entry of STATUS_PHRASES) ctx.statuses.add(entry.words, entry);
  for (const entry of SORT_PHRASES) ctx.sorts.add(wordsOf(entry.phrase), entry);
  for (const entry of DATE_WINDOWS) {
    ctx.windows.add(wordsOf(entry.phrase), { from: entry.from, to: entry.to, label: entry.label });
  }
  for (const [phrase, fn] of Object.entries(AGGREGATE_WORDS)) ctx.aggregates.add(wordsOf(phrase), fn);

  return ctx;
}

const AGGREGATE_WORDS: Readonly<Record<string, AggregateFn>> = {
  count: "count",
  "how many": "count",
  distinct: "count-distinct",
  median: "median",
  typical: "median",
  average: "avg",
  mean: "avg",
  total: "sum",
  sum: "sum",
  longest: "max",
  highest: "max",
  max: "max",
  shortest: "min",
  lowest: "min",
  min: "min",
  p90: "p90",
};
