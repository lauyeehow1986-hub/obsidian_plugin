/**
 * Writing a query result out of the plugin and into the vault (§7 A2, A3).
 *
 * Three guards, and deliberately only three (§7 A3): everything lands in
 * `95 Exports/`, the caller confirms with the file name and row count in front
 * of them, and the write appends an `export` entry to the audit ledger (§5.6).
 * There is no redaction machinery — the export carries what the board showed.
 *
 * The ledger entry is written **after** the file, and only if the file was
 * written. A ledger claiming an export that never happened is worse than a
 * missing row, because the ledger is the thing a sceptical reader is supposed
 * to be able to trust.
 */

import { normalizePath, type App, type TFile } from "obsidian";
import type { AuditEntry } from "../domain/audit/ledger";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";

export interface ExporterDeps {
  app: App;
  audit: AuditLog;
  exportsFolder: () => string;
  actor: () => string;
}

export interface ExportRequest {
  /** Becomes the file name, with a date and, if needed, a counter appended. */
  basename: string;
  extension: "csv" | "md" | "html";
  content: string;
  /** What was exported, for the ledger: a view id, a board name. */
  subject: string;
  /** Rows in the file, for the ledger and the confirmation. */
  rows: number;
}

export interface ExportResult {
  file: TFile;
  path: string;
  rows: number;
}

/** Strip anything a vault path cannot carry, without silently emptying the name. */
export function safeBasename(value: string, fallback = "export"): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? fallback : cleaned.slice(0, 80);
}

export class Exporter {
  constructor(private readonly deps: ExporterDeps) {}

  /** The path an export would take, so a confirmation can name it before writing. */
  plannedPath(basename: string, extension: string, now = Date.now()): string {
    const folder = normalizePath(this.deps.exportsFolder());
    return `${folder}/${safeBasename(basename)}-${toVaultDate(now)}.${extension}`;
  }

  async write(request: ExportRequest): Promise<ExportResult> {
    const actor = this.deps.actor().trim();
    if (actor === "") {
      // Rule 9: a consequential action with no actor is not loggable, so it is
      // not permitted. Better a refusal the user can fix than an anonymous row.
      throw new Error(
        "Set your initials in SCDB Cockpit settings before exporting — every export is recorded in the audit ledger against an actor.",
      );
    }

    const folder = normalizePath(this.deps.exportsFolder());
    await ensureFolder(this.deps.app, folder);

    const path = await this.freePath(folder, safeBasename(request.basename), request.extension);
    const file = await this.deps.app.vault.create(path, request.content);

    const entry: AuditEntry = {
      ts: toVaultMinute(Date.now()),
      actor,
      action: "export",
      subject: request.subject,
      // Counts and paths only — never a cell of the data itself (rule 7).
      detail: `${request.rows} row${request.rows === 1 ? "" : "s"} → ${path}`,
    };
    await this.deps.audit.append([entry]);

    return { file, path, rows: request.rows };
  }

  /** First free `name-date.ext`, then `name-date-2.ext`. Never overwrites (rule 8). */
  private async freePath(folder: string, basename: string, extension: string): Promise<string> {
    const stamp = toVaultDate(Date.now());
    for (let counter = 1; counter < 100; counter++) {
      const suffix = counter === 1 ? "" : `-${counter}`;
      const candidate = normalizePath(`${folder}/${basename}-${stamp}${suffix}.${extension}`);
      if (this.deps.app.vault.getAbstractFileByPath(candidate) === null) return candidate;
    }
    throw new Error(
      `There are already 99 exports named "${basename}" today. Rename or clear some in ${folder}.`,
    );
  }
}
