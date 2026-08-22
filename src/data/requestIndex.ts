/**
 * The request projection over the note index (CLAUDE.md §7 A2).
 *
 * `NoteIndex` holds every typed note; this holds the parsed `RequestNote` for
 * the ones that are requests. Keeping it a projection rather than a second
 * index means one read of Obsidian's metadata cache and one definition of what
 * is in scope — the alternative drifts the moment a vault event is handled in
 * one place and not the other.
 *
 * A request filed outside `10 Requests/` still counts: the folder is a
 * convention, and a note that declares the type should never quietly vanish
 * from the queue because someone moved it.
 */

import { TFile, type App } from "obsidian";
import { requestMetrics, type MetricsOptions } from "../domain/request/dwell";
import type { RequestView } from "../domain/request/holdup";
import { parseRequest, type RequestNote } from "../domain/request/request";
import type { NoteIndex } from "./noteIndex";
import type { WorkflowStore } from "./workflowStore";

export const REQUEST_TYPE = "scdb-request";

export interface IndexEntry {
  file: TFile;
  request: RequestNote;
  /** What could not be read from this note. */
  problems: string[];
}

export class RequestIndex {
  private entries = new Map<string, IndexEntry>();

  constructor(
    private readonly app: App,
    private readonly notes: NoteIndex,
    private readonly workflows: WorkflowStore,
  ) {}

  rebuild(): void {
    this.entries.clear();
    for (const file of this.app.vault.getMarkdownFiles()) this.update(file);
  }

  /** Re-read one file. Removes it from the index if it is no longer a request. */
  update(file: TFile): boolean {
    const entry = this.notes.byPath(file.path);
    if (!entry || entry.type !== REQUEST_TYPE) {
      return this.entries.delete(file.path);
    }
    const { request, problems } = parseRequest(entry.frontmatter);
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
