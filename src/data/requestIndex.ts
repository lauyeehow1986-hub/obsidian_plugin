/**
 * The in-memory request index (CLAUDE.md §7 A2, built early because A1 needs it).
 *
 * Built from Obsidian's metadata cache and updated incrementally on change, so
 * nothing here parses a file itself. Rebuilding a whole vault is a map over
 * cached frontmatter; a single change touches one entry.
 */

import { TFile, type App, type CachedMetadata } from "obsidian";
import { requestMetrics, type MetricsOptions } from "../domain/request/dwell";
import type { RequestView } from "../domain/request/holdup";
import { parseRequest, type RequestNote } from "../domain/request/request";
import type { WorkflowStore } from "./workflowStore";

export const REQUEST_TYPE = "scdb-request";

export interface IndexEntry {
  file: TFile;
  request: RequestNote;
  /** What could not be read from this note. */
  problems: string[];
}

/** Frontmatter as the metadata cache reports it, minus its own bookkeeping. */
function cleanFrontmatter(cache: CachedMetadata | null): Record<string, unknown> | null {
  const frontmatter = cache?.frontmatter;
  if (!frontmatter) return null;
  const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
  return rest;
}

export class RequestIndex {
  private entries = new Map<string, IndexEntry>();

  constructor(
    private readonly app: App,
    private readonly requestsFolder: () => string,
    private readonly workflows: WorkflowStore,
  ) {}

  /** True when a path is somewhere the index cares about. */
  private inScope(path: string): boolean {
    const folder = this.requestsFolder();
    // Notes outside the folder still count if they declare the type — the
    // folder is a convention, and a request filed elsewhere should not vanish.
    return path.endsWith(".md") || path.startsWith(`${folder}/`);
  }

  rebuild(): void {
    this.entries.clear();
    for (const file of this.app.vault.getMarkdownFiles()) this.update(file);
  }

  /** Re-read one file. Removes it from the index if it is no longer a request. */
  update(file: TFile): boolean {
    if (!this.inScope(file.path)) return false;
    const frontmatter = cleanFrontmatter(this.app.metadataCache.getFileCache(file));
    if (!frontmatter || frontmatter["type"] !== REQUEST_TYPE) {
      return this.entries.delete(file.path);
    }
    const { request, problems } = parseRequest(frontmatter);
    this.entries.set(file.path, { file, request, problems });
    return true;
  }

  remove(path: string): boolean {
    return this.entries.delete(path);
  }

  rename(oldPath: string, file: TFile): void {
    this.entries.delete(oldPath);
    this.update(file);
  }

  get size(): number {
    return this.entries.size;
  }

  all(): IndexEntry[] {
    return [...this.entries.values()];
  }

  byPath(path: string): IndexEntry | null {
    return this.entries.get(path) ?? null;
  }

  /** Lookup by the immutable identity. This is what machine references use. */
  byUid(uid: string): IndexEntry | null {
    return this.all().find((e) => e.request.uid === uid) ?? null;
  }

  /** Lookup by the human label. May be renumbered, so never store this. */
  byId(id: string): IndexEntry | null {
    const wanted = id.trim().toLowerCase();
    return this.all().find((e) => e.request.id.toLowerCase() === wanted) ?? null;
  }

  /** Every human label in the vault, for allocating the next one. */
  ids(): string[] {
    return this.all()
      .map((e) => e.request.id)
      .filter((id) => id !== "");
  }

  /** The whole queue with metrics computed at `now`. Nothing is cached — see §5.1. */
  views(options: MetricsOptions): RequestView[] {
    return this.all().map((entry) => ({
      request: entry.request,
      metrics: requestMetrics(
        entry.request,
        this.workflows.forRequest(entry.request.workflow),
        options,
      ),
    }));
  }

  /** The index entry behind a view, for opening the note. */
  fileFor(request: RequestNote): TFile | null {
    return this.all().find((e) => e.request.uid === request.uid)?.file ?? null;
  }
}
