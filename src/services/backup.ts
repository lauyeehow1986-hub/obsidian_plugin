/**
 * Encrypted vault snapshots (CLAUDE.md §7 A4).
 *
 * **This is the one module in the plugin that touches `fs`, and the only one
 * that writes outside the vault.** Rule 8 forbids both; A4 requires a snapshot
 * written to a destination outside the vault, because a backup stored inside
 * the thing it is backing up is not a backup. The two are reconciled by
 * confining the exception rather than spreading it:
 *
 *  - Reads of the vault go through `app.vault` like everything else.
 *  - Restores write through `app.vault` like everything else.
 *  - `fs` is used only under the configured destination folder, and only on
 *    files whose names this plugin generated (`domain/backup/snapshots.ts`).
 *  - A destination inside the vault is refused outright.
 *
 * What is in a snapshot: every file Obsidian tracks — notes and attachments.
 * What is not: `.obsidian/`, so plugin settings, themes, workspace layout and
 * the community-plugin list are **not** restored by this. That is a deliberate
 * line. Configuration is reproducible from a plugin zip; the notes are not.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath, type App, type TFile } from "obsidian";
import {
  checkIntegrity,
  packArchive,
  unpackArchive,
  type ArchiveFile,
  type IntegrityFault,
  type Manifest,
} from "../domain/backup/archive";
import { open, readHeader, seal, type EnvelopeHeader } from "../domain/backup/envelope";
import { planRestore, type RestorePlan } from "../domain/backup/restore";
import {
  planRetention,
  parseSnapshotName,
  snapshotName,
  type Retention,
} from "../domain/backup/snapshots";
import { toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";
import { nodeCryptoBox } from "./cryptoBox";

/**
 * A standalone `ArrayBuffer` for `vault.createBinary`.
 *
 * The unpacked files are `subarray` views onto one large container, so passing
 * `bytes.buffer` straight through would hand Obsidian the entire archive and
 * write the wrong thing to every path.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** The desktop adapter. Narrowed rather than cast to `any` (§8). */
interface BasePathAdapter {
  getBasePath?: () => string;
}

export interface BackupSettings {
  destination: string;
  keep: number;
  intervalDays: number;
}

export interface BackupDeps {
  app: App;
  audit: AuditLog;
  actor: () => string;
  settings: () => BackupSettings;
  pluginVersion: () => string;
}

export interface SnapshotFile {
  name: string;
  bytes: number;
  /** From the name, not the filesystem: a copied file keeps its snapshot time. */
  at: number;
}

export interface SnapshotPlan {
  /** Files that would go in. */
  files: number;
  bytes: number;
  name: string;
  destination: string;
  retention: Retention;
}

export interface CreateResult {
  name: string;
  path: string;
  files: number;
  /** Size of the sealed file on disk. */
  bytes: number;
  removed: string[];
  at: number;
}

export interface VerifyResult {
  header: EnvelopeHeader;
  manifest: Manifest;
  files: number;
  bytes: number;
  faults: IntegrityFault[];
}

export class BackupService {
  constructor(private readonly deps: BackupDeps) {}

  /**
   * Why the destination cannot be used, in a sentence, or null when it can.
   *
   * Checked before every operation rather than once at load: the destination is
   * a path on a machine, and a network share or a USB stick can be there in the
   * morning and gone by the afternoon.
   */
  async destinationProblem(): Promise<string | null> {
    const configured = this.deps.settings().destination.trim();
    if (configured === "") {
      return "No backup destination is set. Choose a folder in SCDB Cockpit settings — on Windows, your Downloads folder is a reasonable starting point.";
    }

    if (!path.isAbsolute(configured)) {
      return `The backup destination must be a full path (it is currently "${configured}").`;
    }

    const vault = this.vaultBasePath();
    if (vault !== null) {
      const target = path.resolve(configured);
      const root = path.resolve(vault);
      if (this.within(target, root)) {
        return "The backup destination is inside the vault. A snapshot stored in the thing it is backing up is not a backup — choose a folder outside it.";
      }
      if (this.within(root, target)) {
        return "The vault is inside the backup destination, so each snapshot would try to include the last. Choose a folder that does not contain the vault.";
      }
    }

    try {
      const stat = await fs.stat(configured);
      if (!stat.isDirectory()) return `The backup destination "${configured}" is not a folder.`;
    } catch {
      return `The backup destination "${configured}" does not exist or cannot be reached.`;
    }
    return null;
  }

  /** True when `child` is `parent` or sits underneath it. */
  private within(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  private vaultBasePath(): string | null {
    // Optional all the way down: `getBasePath` is a desktop-adapter method, and
    // an adapter that does not have one is a reason to skip the containment
    // check, not a reason to throw during a settings screen.
    const adapter = this.deps.app.vault.adapter as unknown as BasePathAdapter | undefined;
    return typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : null;
  }

  private resolve(name: string): string {
    const folder = this.deps.settings().destination.trim();
    const full = path.resolve(folder, name);
    // Belt and braces on top of the name pattern: a name that resolved anywhere
    // other than directly inside the destination is never written or deleted.
    if (path.dirname(full) !== path.resolve(folder)) {
      throw new Error(`Refusing to touch "${name}": it does not sit directly in the destination.`);
    }
    return full;
  }

  private async exists(fullPath: string): Promise<boolean> {
    try {
      await fs.stat(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every name in the destination, snapshots and otherwise.
   *
   * Retention planning needs the unfiltered list: the point of the `foreign`
   * bucket is to be able to say "there are 40 other files here and none of them
   * will be touched", and filtering before planning would make that count zero
   * however full the folder is.
   */
  private async names(): Promise<string[]> {
    if ((await this.destinationProblem()) !== null) return [];
    return fs.readdir(this.deps.settings().destination.trim());
  }

  /** Snapshots already in the destination, newest first. Foreign files ignored. */
  async list(): Promise<SnapshotFile[]> {
    const found: SnapshotFile[] = [];
    for (const name of await this.names()) {
      const at = parseSnapshotName(name);
      if (at === null) continue;
      try {
        const stat = await fs.stat(this.resolve(name));
        if (stat.isFile()) found.push({ name, bytes: stat.size, at });
      } catch {
        // Vanished between the listing and the stat. Not our problem to report.
      }
    }
    return found.sort((a, b) => b.at - a.at);
  }

  /** Everything the confirmation needs, without reading a single file body. */
  async plan(now = Date.now()): Promise<SnapshotPlan> {
    const files = this.vaultFiles();
    const settings = this.deps.settings();
    const name = snapshotName(now);

    return {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.stat.size, 0),
      name,
      destination: settings.destination.trim(),
      // The sweep runs *after* the new snapshot is written, so the confirmation
      // has to plan against the folder as it will be then. Planning against the
      // folder as it is now under-reports by exactly one, which means a
      // confirmation that mentions no deletions and then deletes something.
      retention: planRetention([...(await this.names()), name], settings.keep),
    };
  }

  private vaultFiles(): TFile[] {
    return this.deps.app.vault.getFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Take a snapshot.
   *
   * The passphrase is a parameter and nothing else: it is never stored on this
   * object, never written to settings, and never logged. Losing it loses the
   * archive, which the dialog says in those words.
   */
  async create(passphrase: string, now = Date.now()): Promise<CreateResult> {
    const actor = this.deps.actor().trim();
    if (actor === "") {
      // Same rule as the exporter: a consequential action with no actor is not
      // loggable, so it is not permitted (rule 9).
      throw new Error(
        "Set your initials in SCDB Cockpit settings before taking a snapshot — every snapshot is recorded in the audit ledger against an actor.",
      );
    }
    const problem = await this.destinationProblem();
    if (problem !== null) throw new Error(problem);

    const files: ArchiveFile[] = [];
    for (const file of this.vaultFiles()) {
      files.push({
        path: file.path,
        bytes: new Uint8Array(await this.deps.app.vault.readBinary(file)),
      });
    }

    const container = packArchive(
      this.deps.app.vault.getName(),
      new Date(now).toISOString(),
      files,
    );
    const sealed = seal(
      {
        container,
        passphrase,
        created: new Date(now).toISOString(),
        plugin: this.deps.pluginVersion(),
        files: files.length,
      },
      nodeCryptoBox(),
    );

    // Write beside the target and rename into place. A half-written file that
    // carries the real name would look like a snapshot and restore like a
    // corruption; a leftover `.part` looks like exactly what it is.
    const name = snapshotName(now);
    const target = this.resolve(name);
    // Rule 8 reaches outside the vault too: a snapshot is a file we cannot
    // recreate, so an existing one is never replaced — not even by a newer
    // snapshot of the same vault.
    if (await this.exists(target)) {
      throw new Error(
        `A snapshot named ${name} is already there. Wait a second and try again, or move it aside.`,
      );
    }
    // A leftover `.part` is an incomplete write from a previous attempt — ours,
    // and worthless by definition. Clearing it is the one deletion here that
    // needs no confirmation, because there is nothing in it to lose.
    const partial = `${target}.part`;
    if (await this.exists(partial)) await fs.unlink(partial);
    await fs.writeFile(partial, sealed, { flag: "wx" });
    await fs.rename(partial, target);

    const removed = await this.sweep();

    await this.deps.audit.append([
      {
        ts: toVaultMinute(now),
        actor,
        // §5.6 has no `backup` action, and a snapshot is precisely an export:
        // the whole vault written to a file that can travel. Reusing `export`
        // keeps the ledger vocabulary the documented one.
        action: "export",
        subject: "BACKUP",
        // Counts, a file name and a folder — never a note path (rule 7).
        detail:
          `${files.length} files → ${name}` +
          (removed.length > 0
            ? `; ${removed.length} older snapshot${removed.length === 1 ? "" : "s"} removed`
            : ""),
      },
    ]);

    return { name, path: target, files: files.length, bytes: sealed.length, removed, at: now };
  }

  /**
   * Apply the retention limit.
   *
   * Only names that `parseSnapshotName` recognises are candidates, so the
   * sweep cannot reach a file it did not write — which matters a great deal
   * when the destination is a folder like Downloads.
   */
  private async sweep(): Promise<string[]> {
    const { remove } = planRetention(await this.names(), this.deps.settings().keep);

    const removed: string[] = [];
    for (const name of remove) {
      try {
        await fs.unlink(this.resolve(name));
        removed.push(name);
      } catch {
        // A snapshot we cannot delete is not a failure of the snapshot we just
        // took. Reported by count; never retried behind the user's back.
      }
    }
    return removed;
  }

  /** The plaintext header. No passphrase needed, and nothing is authenticated. */
  async inspect(name: string): Promise<EnvelopeHeader> {
    return readHeader(new Uint8Array(await fs.readFile(this.resolve(name))));
  }

  /**
   * Decrypt a snapshot and check it, writing nothing.
   *
   * "A backup that has never been restored is not a backup" (§7 A4). This is
   * the cheap half of that: it proves the passphrase works, the tag
   * authenticates, the container parses, and every file still hashes to what
   * the manifest recorded.
   */
  async verify(name: string, passphrase: string): Promise<VerifyResult> {
    const bytes = new Uint8Array(await fs.readFile(this.resolve(name)));
    const header = readHeader(bytes);
    const archive = unpackArchive(open(bytes, passphrase, nodeCryptoBox()));

    return {
      header,
      manifest: archive.manifest,
      files: archive.files.length,
      bytes: archive.files.reduce((total, file) => total + file.bytes.length, 0),
      faults: checkIntegrity(archive),
    };
  }

  /** What a restore would do. Reads the snapshot; touches nothing in the vault. */
  async planRestoreFrom(name: string, passphrase: string): Promise<RestorePlan & { manifest: Manifest }> {
    const bytes = new Uint8Array(await fs.readFile(this.resolve(name)));
    const archive = unpackArchive(open(bytes, passphrase, nodeCryptoBox()));
    const existing = new Set(this.deps.app.vault.getFiles().map((file) => file.path));
    return { ...planRestore(archive.files, existing), manifest: archive.manifest };
  }

  /**
   * Write the missing files back, through the vault API.
   *
   * Creates only — `planRestore` has already removed anything that exists, and
   * a second existence check here guards the gap between planning and
   * confirming. Failures are collected rather than thrown so one unwritable
   * path does not abandon the other four hundred.
   */
  async applyRestore(plan: RestorePlan): Promise<{ created: number; failed: string[] }> {
    const failed: string[] = [];
    let created = 0;

    for (const file of plan.create) {
      const target = normalizePath(file.path);
      try {
        if (this.deps.app.vault.getAbstractFileByPath(target) !== null) continue;
        const folder = target.split("/").slice(0, -1).join("/");
        if (folder !== "") await ensureFolder(this.deps.app, folder);
        await this.deps.app.vault.createBinary(target, toArrayBuffer(file.bytes));
        created++;
      } catch {
        failed.push(file.path);
      }
    }

    return { created, failed };
  }
}
