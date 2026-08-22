/**
 * Working out what fields a note type has, by looking at the notes (§7 A2).
 *
 * The vault contract (§5) grows note types faster than any hard-coded list can
 * keep up with, and a query engine that only knows the types someone
 * remembered to declare is always slightly out of date. So types without a
 * declared catalogue get one inferred from the frontmatter actually present.
 *
 * Inference is a convenience, never a claim. A field it guesses wrong about is
 * still filterable, just with the operators of the wrong kind — which is why
 * requests, whose interesting fields are computed and whose gates depend on
 * them, declare their catalogue instead.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isTimestamp } from "../time/dates";
import type { FieldDef } from "./model";

export function looksLikeLink(value: unknown): boolean {
  return typeof value === "string" && /^\s*\[\[.+\]\]\s*$/.test(value);
}

export function inferKind(value: unknown): FieldDef["kind"] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return value.length === 0 ? null : "list";
  if (looksLikeLink(value)) return "link";
  // Only strings that parse as a date become dates. A `title` that happens to
  // start with a year must not become a date field.
  if (typeof value === "string" && isTimestamp(value)) return "date";
  if (typeof value === "string") return "text";
  return null;
}

/** Frontmatter flattened one level, so `governance.identifiers` is addressable. */
export function flattenFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    out[key] = value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${key}.${inner}`] = innerValue;
      }
    }
  }
  return out;
}

/** Turn a field id into something a person reads: `irb_expiry` → "Irb expiry". */
function humanise(id: string): string {
  const last = id.split(".").pop() ?? id;
  const words = last.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Infer a catalogue for one type from the notes present.
 *
 * A field is included once any note carries a readable value for it, and takes
 * the kind of the first such value. Sampling every note would be wasted work on
 * a large vault; the cap is generous enough that a rarely used field on note
 * 200 still appears.
 */
export function inferFields(
  frontmatters: readonly Record<string, unknown>[],
  sample = 200,
): FieldDef[] {
  const kinds = new Map<string, FieldDef["kind"]>();
  for (const frontmatter of frontmatters.slice(0, sample)) {
    for (const [key, value] of Object.entries(flattenFrontmatter(frontmatter))) {
      if (key === "type" || kinds.has(key)) continue;
      const kind = inferKind(value);
      if (kind !== null) kinds.set(key, kind);
    }
  }
  return [...kinds.entries()]
    .map(([id, kind]) => ({ id, label: humanise(id), kind }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
