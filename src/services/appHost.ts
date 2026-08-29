/**
 * Running a vault app: the frame, the broker and the watchdog (§5.13, §7 F3).
 *
 * This is the only code that can start an app, and it only ever does so from
 * an explicit action (rule 12). Nothing runs on note open, on vault load or on
 * sync.
 *
 * **The frame is where the guarantees live.** `sandbox="allow-scripts"` with
 * no `allow-same-origin` gives the app an opaque origin: it cannot read this
 * document, cannot reach `localStorage`, cannot touch Obsidian. What that
 * attribute does *not* do is stop a network call — a sandboxed frame can still
 * `fetch()` a public URL — so the page carries a `default-src 'none'` policy
 * as well (see `domain/apps/frame.ts`). Rules 3 and 4 rest on both together.
 *
 * **Everything crossing the boundary is data.** The frame is handed a runtime
 * and a message port, never an object: §5.13 forbids passing `App`, `Plugin`,
 * `Vault` or `adapter` into an app, because `app.vault.adapter` is arbitrary
 * filesystem access and would make the manifest decorative. Structured clone
 * could not carry them across anyway, which is a pleasant coincidence rather
 * than the reason.
 *
 * **The watchdog is honest about what it buys.** It pings; a frame that stops
 * answering is offered for teardown. §5.13 records the open question it cannot
 * settle: whether this Electron build isolates a sandboxed iframe into its own
 * renderer process. If it does, a runaway loop stalls only the app. If it does
 * not, Obsidian's own UI thread is stalled and the watchdog's timer will not
 * fire either — so this detects a *wedged* app, not every possible one, and
 * saying otherwise would be a false promise. `Diagnostics` reports the version
 * so the question can be answered on the machine that matters.
 */

import { Notice, type App, type TFile } from "obsidian";

import {
  authoriseQuery,
  authoriseTarget,
  authoriseWrite,
  describeProposal,
  isAppRequest,
  PROTOCOL_VERSION,
  type FieldChange,
  type WriteProposal,
} from "../domain/apps/broker";
import { buildFrame, THEME_VARIABLES, themeCss } from "../domain/apps/frame";
import type { AppManifest } from "../domain/apps/manifest";
import { runQuery } from "../domain/query/evaluate";
import type { FieldDef, Row } from "../domain/query/model";
import { parseQuery } from "../domain/query/savedView";
import { toVaultMinute } from "../domain/time/dates";
import type { AuditLog } from "./auditLog";

export interface AppHostContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  rows: (types: readonly string[], now: number) => Row[];
  fields: (types: readonly string[]) => FieldDef[];
  /** Seconds of silence before the app is offered for teardown. */
  watchdogSeconds: () => number;
  /**
   * Show the proposed change and wait for an answer.
   *
   * §5.13 and rule 5: an app's output is a proposal. It populates a dialog; it
   * never changes a note by itself. Resolving false is a decline, and the app
   * is told only that — it cannot distinguish "you said no" from "your
   * manifest does not allow it", which is the correct amount for it to know.
   */
  confirmWrite: (
    manifest: AppManifest,
    proposal: WriteProposal,
    changes: FieldChange[],
  ) => Promise<boolean>;
}

export type SessionState = "starting" | "running" | "wedged" | "stopped" | "failed";

/** Read Obsidian's live theme values, for copying into the frame (§6). */
export function readTheme(element: HTMLElement): Record<string, string> {
  const computed = getComputedStyle(element);
  const values: Record<string, string> = {};
  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name);
    if (value.trim() !== "") values[name] = value;
  }
  return values;
}

/**
 * One running app.
 *
 * Created per mount and thrown away on stop — a session is not reused, so a
 * restart genuinely restarts rather than reviving whatever state wedged it.
 */
export class AppSession {
  private frame: HTMLIFrameElement | null = null;
  private listener: ((event: MessageEvent) => void) | null = null;
  private watchdog: number | null = null;
  private lastSeen = 0;
  private started = false;
  /** One proposal at a time: an app must not be able to stack twenty dialogs. */
  private proposing = false;
  private pingId = 0;

  state: SessionState = "stopped";

  constructor(
    private readonly ctx: AppHostContext,
    private readonly manifest: AppManifest,
    private readonly onState: (state: SessionState, detail: string) => void,
  ) {}

  /** Build the frame and let it run. The caller has already checked consent. */
  start(container: HTMLElement, runtime: string): void {
    this.stop();
    this.setState("starting", "");

    const frame = document.createElement("iframe");
    frame.addClass("scdb-app-frame");
    // No `allow-same-origin`: with it, the frame would share this origin and
    // the sandbox would be worth nothing. No `allow-popups`, no `allow-forms`,
    // no `allow-modals` — an app that can open a dialog can impersonate one.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", `${this.manifest.title} (vault app)`);
    frame.srcdoc = buildFrame({
      runtime,
      source: this.manifest.source,
      title: this.manifest.title,
      theme: readTheme(container),
    });

    this.listener = (event: MessageEvent) => this.onMessage(event);
    window.addEventListener("message", this.listener);
    container.appendChild(frame);
    this.frame = frame;

    this.lastSeen = Date.now();
    const seconds = Math.max(2, this.ctx.watchdogSeconds());
    this.watchdog = window.setInterval(() => this.checkAlive(seconds), 1000);
  }

  stop(): void {
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.listener !== null) {
      window.removeEventListener("message", this.listener);
      this.listener = null;
    }
    this.frame?.remove();
    this.frame = null;
    this.started = false;
    this.proposing = false;
    if (this.state !== "stopped") this.setState("stopped", "");
  }

  /** Push fresh theme values in, without restarting the app (§5.13). */
  refreshTheme(container: HTMLElement): void {
    this.post({ scdb: PROTOCOL_VERSION, kind: "theme", css: themeCss(readTheme(container)) });
  }

  private setState(state: SessionState, detail: string): void {
    this.state = state;
    this.onState(state, detail);
  }

  private post(message: unknown): void {
    // "*" is the only target that can match an opaque origin. Nothing secret
    // travels this way, and the frame checks that the sender is its parent.
    this.frame?.contentWindow?.postMessage(message, "*");
  }

  private checkAlive(seconds: number): void {
    if (!this.started) return;
    this.pingId += 1;
    this.post({ scdb: PROTOCOL_VERSION, kind: "ping", id: this.pingId });
    if (Date.now() - this.lastSeen > seconds * 1000 && this.state === "running") {
      this.setState(
        "wedged",
        `${this.manifest.title} has not answered for ${seconds} seconds. It may be stuck in a loop.`,
      );
    }
  }

  private onMessage(event: MessageEvent): void {
    // Identity, not origin. The frame's origin is the string "null" for every
    // sandboxed frame on the page, so it distinguishes nothing; the window
    // reference distinguishes exactly one frame, which is ours.
    if (this.frame === null || event.source !== this.frame.contentWindow) return;
    if (!isAppRequest(event.data)) return;
    const request = event.data;

    this.lastSeen = Date.now();
    if (this.state === "wedged") this.setState("running", "");

    switch (request.kind) {
      case "ready":
        this.started = true;
        this.setState("running", "");
        return;
      case "pong":
        return;
      case "failed":
        // The frame already painted the error; this is so the pane can show it
        // outside the frame too, where the person is actually looking.
        this.setState(
          "failed",
          typeof request.payload?.message === "string" ? request.payload.message : "The app failed.",
        );
        return;
      case "query":
      case "notes":
        void this.answerQuery(request.id, request.payload ?? {});
        return;
      case "propose":
        void this.answerPropose(request.id, request.payload ?? {});
        return;
    }
  }

  private reply(id: number, data: unknown): void {
    this.post({ scdb: PROTOCOL_VERSION, id, ok: true, data });
  }

  private refuse(id: number, error: string): void {
    this.post({ scdb: PROTOCOL_VERSION, id, ok: false, error });
  }

  /**
   * Answer a read.
   *
   * The payload is parsed through the saved-view parser rather than trusted as
   * a `Query`: it arrives from app code, and that parser already exists to
   * make sense of a query object a human hand-edited into a note. The types
   * are then *overwritten* with what the manifest allows, so a filter cannot
   * reach past the grant however it is spelled.
   */
  private async answerQuery(id: number, payload: Record<string, unknown>): Promise<void> {
    const allowed = authoriseQuery(payload, this.manifest);
    if (!allowed.ok) {
      this.refuse(id, allowed.error);
      return;
    }

    const problems: string[] = [];
    const query = parseQuery(payload, problems);
    query.types = allowed.value;

    const now = Date.now();
    const result = runQuery(this.ctx.rows(allowed.value, now), query, this.ctx.fields(allowed.value), {
      now,
    });

    const rows = result.groups.flatMap((group) =>
      group.rows.map((row) => ({ ...row.fields, path: row.key, type: row.type })),
    );

    this.reply(id, {
      rows,
      matched: result.matched,
      groups: result.groups.map((group) => ({
        key: group.key,
        label: group.label,
        count: group.rows.length,
        aggregates: group.aggregates.map((value) => ({ label: value.label, value: value.value })),
      })),
      problems: [...problems, ...result.problems],
    });
  }

  /**
   * Answer a proposed change.
   *
   * Four checks before anything is shown, and a person after them: the
   * manifest allows writes at all; the fields are not the ones no app may
   * touch; the note exists; and its type is one the app may read. Only then
   * does a dialog open, and only a confirmation there writes anything.
   */
  private async answerPropose(id: number, payload: Record<string, unknown>): Promise<void> {
    const allowed = authoriseWrite(payload, this.manifest);
    if (!allowed.ok) {
      this.refuse(id, allowed.error);
      return;
    }
    if (this.proposing) {
      this.refuse(id, "There is already a change from this app waiting for an answer.");
      return;
    }

    const proposal = allowed.value;
    const file = this.ctx.app.vault.getAbstractFileByPath(proposal.path);
    if (file === null || !("extension" in file)) {
      this.refuse(id, `There is no note at ${proposal.path}.`);
      return;
    }
    const target = file as TFile;

    const cache = this.ctx.app.metadataCache.getFileCache(target);
    const { position: _position, ...current } = (cache?.frontmatter ?? {}) as Record<
      string,
      unknown
    >;

    const targetType = authoriseTarget(
      typeof current.type === "string" ? current.type : "",
      this.manifest,
    );
    if (!targetType.ok) {
      this.refuse(id, targetType.error);
      return;
    }

    const changes = describeProposal(proposal, current);
    if (changes.length === 0) {
      this.reply(id, { applied: false, reason: "Nothing to change — those values are already set." });
      return;
    }

    const actor = this.ctx.actor().trim();
    if (actor === "") {
      this.refuse(
        id,
        "Set your initials in SCDB Cockpit settings first — a change made through an app is recorded in the audit ledger against an actor.",
      );
      return;
    }

    this.proposing = true;
    try {
      const confirmed = await this.ctx.confirmWrite(this.manifest, proposal, changes);
      if (!confirmed) {
        this.refuse(id, "You declined this change.");
        return;
      }

      await this.ctx.app.fileManager.processFrontMatter(target, (front) => {
        for (const change of changes) front[change.key] = change.after;
      });

      await this.ctx.audit.append([
        {
          ts: toVaultMinute(Date.now()),
          actor,
          action: "app-write",
          subject: target.basename,
          // Field names and counts, never values (rule 7). Which fields moved
          // is what a reader needs; what they moved to is in the note.
          detail: `${this.manifest.id} proposed and you confirmed: ${changes.map((change) => change.key).join(", ")}`,
        },
      ]);

      new Notice(`${this.manifest.title}: updated ${target.basename}.`, 4000);
      this.reply(id, { applied: true, fields: changes.map((change) => change.key) });
    } catch (error) {
      this.refuse(id, error instanceof Error ? error.message : "The change could not be written.");
    } finally {
      this.proposing = false;
    }
  }
}
