/**
 * The vocabulary the English search box knows (CLAUDE.md §7 B4).
 *
 * Everything in it comes from this vault: the field catalogue for the types in
 * play, the stage names the installed workflow spec declares, and the names
 * that actually appear in frontmatter. Nothing is hard-coded here, which is
 * why swapping the placeholder stages for the real eData ones (§5.2) teaches
 * the search box the new words with no code change.
 *
 * Read from the metadata cache rather than from built rows: a name list must
 * not cost a dwell-time computation per note on every keystroke.
 */

import { linkTarget } from "../domain/query/evaluate";
import { NAME_FIELDS } from "../domain/query/phrases";
import { flattenFrontmatter } from "../domain/query/infer";
import type { Vocabulary } from "../domain/query/language";
import { catalogueFor, type RowSourceDeps } from "./rows";

/**
 * A ceiling on how many distinct names one field contributes.
 *
 * A vault with thousands of distinct requesters would otherwise build a very
 * large phrase index on every keystroke. Names beyond the cap simply are not
 * matched — the search says it did not understand them, which is the honest
 * failure rather than a slow one.
 */
const VALUE_CAP = 500;

function collect(deps: RowSourceDeps, types: readonly string[], fields: readonly string[]): Record<string, string[]> {
  const wanted = types.length === 0 ? null : new Set(types);
  const seen = new Map<string, Set<string>>(fields.map((field) => [field, new Set<string>()]));

  for (const entry of deps.notes.all()) {
    if (wanted && !wanted.has(entry.type)) continue;
    const flat = flattenFrontmatter(entry.frontmatter);
    for (const field of fields) {
      const bucket = seen.get(field);
      if (bucket === undefined || bucket.size >= VALUE_CAP) continue;
      const raw = flat[field];
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value !== "string") continue;
        const name = linkTarget(value).trim();
        if (name !== "") bucket.add(name);
      }
    }
  }

  return Object.fromEntries([...seen].map(([field, values]) => [field, [...values]]));
}

export function buildVocabulary(deps: RowSourceDeps, types: readonly string[]): Vocabulary {
  const fields = catalogueFor(deps, types);
  const ids = new Set(fields.map((field) => field.id));
  const names = NAME_FIELDS.filter((field) => ids.has(field));

  // Stages from every installed spec. Two specs that disagree about what a
  // stage id is called make that word ambiguous, and the parser then refuses
  // it rather than picking one (§B4: predictable, never a guess).
  // Deduplicated, so two specs that name a stage identically stay one word
  // rather than colliding with themselves.
  const byStage = new Map<string, { id: string; label: string }>();
  for (const spec of deps.workflows.usable()) {
    for (const stage of spec.stages) {
      byStage.set(`${stage.id}\u0000${stage.label}`, { id: stage.id, label: stage.label });
    }
  }
  const stages = [...byStage.values()];

  return {
    fields,
    types: deps.notes.types().map((entry) => entry.type),
    stages,
    values: collect(deps, types, names),
  };
}
