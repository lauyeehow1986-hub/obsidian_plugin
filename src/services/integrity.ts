/**
 * Running the integrity check against a real vault (CLAUDE.md §7 A4).
 *
 * The rules are in `domain/integrity`; this is the part that has to ask
 * Obsidian how a wikilink resolves, read the ledger, and — for the one repair
 * on offer — create a note.
 */

import { normalizePath, type App } from "obsidian";
import {
  checkIntegrity,
  type Finding,
  type IntegrityNote,
  type Repair,
} from "../domain/integrity/links";
import { REQUEST_TYPE } from "../data/requestIndex";
import { ensureFolder } from "../data/vaultPaths";
import type ScdbCockpitPlugin from "../main.js";

/**
 * Which folder a stub belongs in, by the field that pointed at it.
 *
 * Only fields whose meaning the vault contract fixes (§5.1, §5.4, §5.10) are
 * listed. A link in a field we do not recognise is still reported — it is just
 * not offered a repair, because putting a note in the wrong folder is worse
 * than leaving the link unresolved.
 */
const PEOPLE_FIELDS = new Set([
  "requester",
  "blocked_on",
  "assignee",
  "owner",
  "authors",
  "with",
  "approver",
  "supervisor",
]);
const STUDY_FIELDS = new Set(["study", "studies", "collected_in"]);

/** Frontmatter for a stub, by folder. Minimal, and honest about its origin. */
const STUB_TYPE: Record<string, string> = { people: "person", studies: "study" };

export function collectIntegrityFindings(
  plugin: ScdbCockpitPlugin,
  ledgerSubjects: readonly string[],
): Finding[] {
  const notes: IntegrityNote[] = plugin.notes
    .all()
    .map((entry) => ({ path: entry.file.path, type: entry.type, frontmatter: entry.frontmatter }));

  return checkIntegrity({
    notes,
    resolve: (target, fromPath) =>
      plugin.app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? null,
    folderFor: (field) => {
      if (PEOPLE_FIELDS.has(field)) return plugin.settings.folders.people;
      if (STUDY_FIELDS.has(field)) return plugin.settings.folders.studies;
      return "";
    },
    ledgerSubjects,
    // Only requests carry a durable `uid` today. Run records and correspondence
    // threads (§5.12, §5.10) join this list when their writers exist; the check
    // needs no change when they do.
    uidTypes: [REQUEST_TYPE],
  });
}

export interface RepairOutcome {
  created: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Create the notes that something already points at.
 *
 * The only repair A4 offers, and deliberately the additive one: a stub can be
 * deleted in a keystroke if it was wrong, whereas nothing here could undo a
 * "fix" that rewrote a link. A path that already exists is skipped rather than
 * touched (rule 8).
 */
export async function applyRepairs(
  app: App,
  repairs: readonly Repair[],
  folderKind: (path: string) => string,
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { created: [], skipped: [], failed: [] };

  for (const repair of repairs) {
    const path = normalizePath(repair.path);
    try {
      if (app.vault.getAbstractFileByPath(path) !== null) {
        outcome.skipped.push(path);
        continue;
      }
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder !== "") await ensureFolder(app, folder);

      const type = STUB_TYPE[folderKind(path)] ?? "note";
      await app.vault.create(
        path,
        `---\ntype: ${type}\ntitle: ${repair.title}\n---\n\n` +
          "Created by the SCDB Cockpit integrity check because notes already linked here. " +
          "Fill it in, or delete it and fix the links that point at it.\n",
      );
      outcome.created.push(path);
    } catch {
      outcome.failed.push(path);
    }
  }

  return outcome;
}
