/**
 * The only place vault-app notes are read, created and exported (§5.13, §7 F3).
 *
 * Reading an app note is the same two-halves problem D2's forms have — the
 * manifest is frontmatter, the code is a fenced block — so it uses the same
 * shared fence reader and the same rule: a write replaces the block and
 * nothing else, so the prose explaining what an app is for survives (rule 8).
 *
 * **Nothing here runs anything.** Rule 12 is explicit: code never runs on note
 * open, on vault load or on sync. This module produces manifests, records
 * consent and writes files; `appHost.ts` is the only thing that can start an
 * app, and only from an explicit action.
 *
 * The consent record does not live in the note. It lives in settings, because
 * a consent stored next to the thing it authorises is not a consent — anyone
 * who can edit the note could edit the grant, which is the exact scenario
 * §5.13's manifest hash exists to make visible.
 */

import { normalizePath, TFile, type App } from "obsidian";

import { newGrant, type AppGrant } from "../domain/apps/grant";
import {
  parseManifest,
  replaceSource,
  VAULT_APP_TYPE,
  type AppManifest,
} from "../domain/apps/manifest";
import { buildExportPage } from "../domain/apps/frame";
import { buildSnapshot, type SnapshotResult } from "../domain/apps/snapshot";
import { assessApp, buildRegister, type AppAssessment } from "../domain/apps/register";
import type { Row } from "../domain/query/model";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { NoteIndex } from "../data/noteIndex";
import type { AuditLog } from "./auditLog";
import type { Exporter, ExportResult } from "./exporter";

export interface AppWriterContext {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  exporter: Exporter;
  actor: () => string;
  appsFolder: () => string;
  /** Read fresh so a grant given a moment ago is visible without a reload. */
  grants: () => Readonly<Record<string, AppGrant>>;
  saveGrant: (id: string, grant: AppGrant | null) => Promise<void>;
  rows: (types: readonly string[], now: number) => Row[];
  /** Obsidian's computed theme values, read by the UI and passed through. */
  theme: () => Record<string, string>;
  /** The bundled sandbox runtime, as source text. */
  runtime: string;
}

export interface NewApp {
  id: string;
  title: string;
  description: string;
  types: string[];
}

export class AppWriter {
  constructor(private readonly ctx: AppWriterContext) {}

  private actorOrThrow(action: string): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        `Set your initials as the actor in SCDB Cockpit settings first — ${action} is recorded in the audit ledger against an actor.`,
      );
    }
    return actor;
  }

  /* ------------------------------------------------------------- reading -- */

  /**
   * Read one app note.
   *
   * `cachedRead` because a board showing ten apps must not hit the disk ten
   * times, and because nothing here needs the freshest possible byte — the
   * manifest is re-read at the moment an app is actually run.
   */
  async manifestFor(file: TFile): Promise<AppManifest> {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    const { position: _position, ...frontmatter } = (cache?.frontmatter ?? {}) as Record<
      string,
      unknown
    >;
    const body = await this.ctx.app.vault.cachedRead(file);
    return parseManifest({ path: file.path, frontmatter, body });
  }

  async manifests(): Promise<AppManifest[]> {
    const entries = this.ctx.notes.byType(VAULT_APP_TYPE);
    return Promise.all(entries.map((entry) => this.manifestFor(entry.file)));
  }

  async register(): Promise<AppAssessment[]> {
    return buildRegister(await this.manifests(), this.ctx.grants());
  }

  /** One app, assessed against the grant it holds now. */
  async assess(file: TFile): Promise<AppAssessment> {
    return assessApp(await this.manifestFor(file), this.ctx.grants());
  }

  fileFor(manifest: AppManifest): TFile | null {
    const found = this.ctx.app.vault.getAbstractFileByPath(manifest.path);
    return found instanceof TFile ? found : null;
  }

  /* ------------------------------------------------------------- consent -- */

  /**
   * Record that an app may run with the capabilities it currently declares.
   *
   * Logged, because §5.6 admits no silent consequential action and this is the
   * moment code gains access to notes. The detail cell carries the capability
   * names and nothing else — never a line of the app's source (rule 7).
   */
  async grant(manifest: AppManifest, previous: AppGrant | undefined): Promise<AppGrant> {
    const actor = this.actorOrThrow("allowing an app to run");
    const grant = newGrant(manifest.capabilities, toVaultDate(Date.now()));
    await this.ctx.saveGrant(manifest.id, grant);

    const change = previous === undefined ? "first run" : "capabilities widened";
    await this.ctx.audit.append([
      {
        ts: toVaultMinute(Date.now()),
        actor,
        action: "app-granted",
        subject: manifest.id,
        detail: `${change}; reads ${manifest.capabilities.query.join(",") || "nothing"}; write ${manifest.capabilities.write}`,
      },
    ]);
    return grant;
  }

  /** Withdraw consent. The app stops being runnable until it asks again. */
  async revoke(manifest: AppManifest): Promise<void> {
    const actor = this.actorOrThrow("withdrawing an app's permission");
    await this.ctx.saveGrant(manifest.id, null);
    await this.ctx.audit.append([
      {
        ts: toVaultMinute(Date.now()),
        actor,
        action: "app-granted",
        subject: manifest.id,
        detail: "withdrawn; the app can no longer run until allowed again",
      },
    ]);
  }

  /* ------------------------------------------------------------ creating -- */

  async create(input: NewApp): Promise<TFile> {
    const folder = normalizePath(this.ctx.appsFolder());
    await ensureFolder(this.ctx.app, folder);

    const id = input.id.trim() === "" ? `APP-${toVaultDate(Date.now())}` : input.id.trim();
    const path = normalizePath(`${folder}/${id}.md`);
    if (this.ctx.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error(`${path} already exists. Choose a different id.`);
    }

    const types = input.types.filter((type) => type.trim() !== "");
    const front = [
      "---",
      `type: ${VAULT_APP_TYPE}`,
      `id: ${id}`,
      `title: ${JSON.stringify(input.title.trim() === "" ? id : input.title.trim())}`,
      `description: ${JSON.stringify(input.description.trim())}`,
      "capabilities:",
      types.length === 0
        ? "  query: []"
        : `  query: [${types.map((type) => JSON.stringify(type)).join(", ")}]`,
      "  write: none",
      "  network: false",
      "export: allowed",
      `updated: ${toVaultDate(Date.now())}`,
      "---",
      "",
      `# ${input.title.trim() === "" ? id : input.title.trim()}`,
      "",
      "What this app is for, and anything a reader needs to know before running it.",
      "",
      starterSource(types[0] ?? ""),
      "",
    ].join("\n");

    return this.ctx.app.vault.create(path, front);
  }

  /** Replace the app's code, leaving the manifest and every word of prose. */
  async writeSource(file: TFile, source: string): Promise<void> {
    await this.ctx.app.vault.process(file, (text) => replaceSource(text, source));
    await this.ctx.app.fileManager.processFrontMatter(file, (front) => {
      front.updated = toVaultDate(Date.now());
    });
  }

  /* ----------------------------------------------------------- exporting -- */

  /**
   * What an export would carry, so the confirmation can say it before writing.
   *
   * Separate from `exportApp` on purpose: §5.10 excludes correspondence from
   * exports by default, and a dialog that does not name what was left out
   * produces a page a colleague cannot read and nobody can explain.
   */
  snapshotFor(manifest: AppManifest, now = Date.now()): SnapshotResult {
    const types = manifest.capabilities.query;
    return buildSnapshot(this.ctx.rows(types, now), { types });
  }

  async exportApp(manifest: AppManifest): Promise<ExportResult> {
    if (manifest.export === "denied") {
      throw new Error(
        `${manifest.id} is marked \`export: denied\` in its own note. Change that there if it should be exportable.`,
      );
    }
    if (manifest.source.trim() === "") {
      throw new Error(`${manifest.id} has no code to export.`);
    }

    const now = Date.now();
    const snapshot = this.snapshotFor(manifest, now);
    const takenAt = toVaultMinute(now);

    const page = buildExportPage({
      runtime: this.ctx.runtime,
      source: manifest.source,
      title: manifest.title,
      theme: this.ctx.theme(),
      rows: snapshot.rows,
      takenAt,
      footer:
        `${manifest.title} — a vault app exported from SCDB Cockpit with a snapshot of ${snapshot.count} ` +
        `note${snapshot.count === 1 ? "" : "s"} taken ${takenAt}. It is not live, and it is not the system of record.`,
    });

    return this.ctx.exporter.write({
      basename: `${manifest.id}`,
      extension: "html",
      content: page,
      subject: manifest.id,
      rows: snapshot.count,
    });
  }
}

/** A first app that renders something real, so a new note is not a blank page. */
function starterSource(type: string): string {
  const queried = type === "" ? "" : type;
  return [
    "```js app",
    "// Runs in a sandbox. It can read only what the manifest above grants,",
    "// and it can never reach the network or the filesystem.",
    "",
    queried === ""
      ? "const Counts = () => html`<p>Add a note type to <code>capabilities.query</code> to read something.</p>`;"
      : [
          "const Counts = () => {",
          `  const { rows, loading, error } = useQuery({ types: ["${queried}"] });`,
          "  if (loading) return html`<p>Loading…</p>`;",
          "  if (error) return html`<p class=\"scdb-app-error\">${error}</p>`;",
          "  return html`",
          `    <h2>\${rows.length} ${queried} notes</h2>`,
          "    <table>",
          "      <thead><tr><th>id</th><th>title</th></tr></thead>",
          "      <tbody>",
          "        ${rows.map((row) => html`<tr key=${row.path}><td>${row.id ?? \"\"}</td><td>${row.title ?? \"\"}</td></tr>`)}",
          "      </tbody>",
          "    </table>",
          "  `;",
          "};",
        ].join("\n"),
    "",
    "mount(Counts);",
    "```",
  ].join("\n");
}
