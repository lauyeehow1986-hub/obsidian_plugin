/**
 * The note index (CLAUDE.md §7 A2) — every note that declares a `type:`.
 *
 * One pass over Obsidian's metadata cache, updated incrementally on change.
 * Nothing here parses a file itself; the cache has already done that, which is
 * what keeps a 5,000-note rebuild inside the A2 budget.
 *
 * `RequestIndex` sits on top of this and adds the request projection, so there
 * is exactly one definition of "a note we care about" and one place that reads
 * the cache.
 */

import { TFile, type App, type CachedMetadata } from "obsidian";

export interface NoteEntry {
  file: TFile;
  /** The `type:` frontmatter value. Never empty — untyped notes are not indexed. */
  type: string;
  /** Frontmatter as cached, minus Obsidian's own `position` bookkeeping. */
  frontmatter: Record<string, unknown>;
}

/** Frontmatter as the metadata cache reports it, minus its own bookkeeping. */
export function cleanFrontmatter(cache: CachedMetadata | null): Record<string, unknown> | null {
  const frontmatter = cache?.frontmatter;
  if (!frontmatter) return null;
  const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
  return rest;
}

export class NoteIndex {
  private entries = new Map<string, NoteEntry>();
  private counts = new Map<string, number>();

  constructor(private readonly app: App) {}

  rebuild(): void {
    this.entries.clear();
    this.counts.clear();
    for (const file of this.app.vault.getMarkdownFiles()) this.update(file);
  }

  /**
   * Re-read one file. Returns true when the index changed, so a caller can
   * decide whether to repaint — most vault events touch notes we do not track.
   */
  update(file: TFile): boolean {
    const frontmatter = cleanFrontmatter(this.app.metadataCache.getFileCache(file));
    const type = typeof frontmatter?.["type"] === "string" ? frontmatter["type"].trim() : "";

    if (frontmatter === null || type === "") return this.remove(file.path);

    const previous = this.entries.get(file.path);
    if (previous) this.bump(previous.type, -1);
    this.entries.set(file.path, { file, type, frontmatter });
    this.bump(type, 1);
    return true;
  }

  remove(path: string): boolean {
    const existing = this.entries.get(path);
    if (!existing) return false;
    this.bump(existing.type, -1);
    this.entries.delete(path);
    return true;
  }

  rename(oldPath: string, file: TFile): boolean {
    const had = this.remove(oldPath);
    return this.update(file) || had;
  }

  private bump(type: string, by: number): void {
    const next = (this.counts.get(type) ?? 0) + by;
    if (next <= 0) this.counts.delete(type);
    else this.counts.set(type, next);
  }

  get size(): number {
    return this.entries.size;
  }

  all(): NoteEntry[] {
    return [...this.entries.values()];
  }

  byPath(path: string): NoteEntry | null {
    return this.entries.get(path) ?? null;
  }

  byType(type: string): NoteEntry[] {
    return this.all().filter((entry) => entry.type === type);
  }

  /** Every type present, with its count, commonest first. For the type picker. */
  types(): { type: string; count: number }[] {
    return [...this.counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
}
