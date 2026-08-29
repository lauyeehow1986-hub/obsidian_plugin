import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";

import type { AppManifest } from "../domain/apps/manifest";
import { AppSession, type SessionState } from "../services/appHost";
import type ScdbCockpitPlugin from "../main.js";

export const APP_VIEW_TYPE = "scdb-app-view";

/**
 * The pane a vault app runs in, and the JavaScript scratchpad (§5.13, §7 F3).
 *
 * One pane for both because §7 F3 says so — "three related surfaces on one
 * runtime" — and because the alternative is two hosts that would drift. The
 * scratchpad is simply an app whose source you are typing rather than one a
 * note holds.
 *
 * **The scratchpad needs no consent, and that is not an oversight.** The grant
 * machinery in §5.13 exists to catch a *note* changing under you: an app you
 * trusted at `write: none` edited later to ask for more, by you, by an update
 * or by whoever sent it. Text you typed into this pane thirty seconds ago
 * cannot change under you, and pressing Run *is* the explicit action rule 12
 * asks for. So the scratchpad runs with read access to what is indexed, no
 * write access at all, and no export.
 *
 * Deliberately not `getState`/`setState` — see the note on `DiagramView` for
 * what overriding those did to that pane. A running app is a workbench, not a
 * document, and it should not survive a restart anyway: rule 12 means the app
 * would have to start itself on load, which is exactly what must not happen.
 */

const SCRATCHPAD_STARTER = `// Scratchpad. Runs in the same sandbox as a vault app:
// no vault access, no filesystem, no network — only what the broker answers.
const Rows = () => {
  const { rows, loading, error } = useQuery({ types: ["scdb-request"] });
  if (loading) return html\`<p>Loading…</p>\`;
  if (error) return html\`<p class="scdb-app-error">\${error}</p>\`;

  const byStage = {};
  for (const row of rows) byStage[row.stage ?? "(none)"] = (byStage[row.stage ?? "(none)"] ?? 0) + 1;

  return html\`
    <h2>\${rows.length} requests</h2>
    <table>
      <thead><tr><th>stage</th><th class="num">n</th></tr></thead>
      <tbody>
        \${Object.entries(byStage).map(([stage, n]) => html\`
          <tr key=\${stage}><td>\${stage}</td><td class="num">\${n}</td></tr>
        \`)}
      </tbody>
    </table>
  \`;
};

mount(Rows);
`;

const STATE_TEXT: Record<SessionState, string> = {
  starting: "Starting…",
  running: "Running",
  wedged: "Not responding",
  stopped: "Stopped",
  failed: "Stopped with an error",
};

export class AppView extends ItemView {
  private path = "";
  private scratchpad = false;
  private manifest: AppManifest | null = null;
  private session: AppSession | null = null;
  private state: SessionState = "stopped";
  private detail = "";
  private source = SCRATCHPAD_STARTER;
  private frameHost: HTMLElement | null = null;
  private wedgeAsked = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return APP_VIEW_TYPE;
  }

  override getDisplayText(): string {
    if (this.scratchpad) return "Scratchpad";
    return this.manifest === null ? "Vault app" : this.manifest.title;
  }

  override getIcon(): string {
    return "layout-grid";
  }

  /** Point the pane at an app note and start it. Consent is already settled. */
  showApp(file: TFile, manifest: AppManifest): void {
    this.scratchpad = false;
    this.path = file.path;
    this.manifest = manifest;
    this.source = manifest.source;
    this.paint();
    this.run();
  }

  /**
   * Open the scratchpad. Nothing runs until Run is pressed (rule 12).
   *
   * **Switching in from an app resets the source, and that is not cosmetic.**
   * The pane is reused, so without this the app's code would still be sitting
   * in the editor — and the scratchpad reads every indexed type, while the app
   * was granted a list. Pressing Run would then execute code you consented to
   * at one scope with a wider one, which is precisely the capability bleed
   * §5.13's grant machinery exists to prevent. Re-opening a scratchpad that is
   * already a scratchpad keeps what you typed, because that is your own work
   * and losing it would be its own bug.
   */
  showScratchpad(): void {
    if (!this.scratchpad) {
      this.stop();
      this.source = SCRATCHPAD_STARTER;
    }
    this.scratchpad = true;
    this.path = "";
    this.manifest = null;
    this.state = "stopped";
    this.paint();
  }

  private currentManifest(): AppManifest {
    if (!this.scratchpad && this.manifest !== null) {
      return { ...this.manifest, source: this.source };
    }
    return {
      path: "",
      id: "SCRATCHPAD",
      title: "Scratchpad",
      description: "",
      capabilities: { query: this.plugin.indexedTypes(), write: "none", network: false },
      export: "denied",
      source: this.source,
      tagged: true,
      updated: "",
      problems: [],
    };
  }

  private run(): void {
    if (this.frameHost === null) return;
    this.wedgeAsked = false;
    this.frameHost.empty();

    const manifest = this.currentManifest();
    if (manifest.source.trim() === "") {
      new Notice("There is no code to run.");
      return;
    }

    this.session?.stop();
    this.session = new AppSession(this.plugin.appHostContext(), manifest, (state, detail) =>
      this.onSessionState(state, detail),
    );
    this.session.start(this.frameHost, this.plugin.sandboxRuntime());
  }

  private onSessionState(state: SessionState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.paintStatus();

    if (state === "wedged" && !this.wedgeAsked) {
      this.wedgeAsked = true;
      void this.plugin.askWedged(this.getDisplayText(), detail).then((stop) => {
        if (stop) this.stop();
      });
    }
  }

  private stop(): void {
    this.session?.stop();
    this.session = null;
    this.state = "stopped";
    this.detail = "";
    this.frameHost?.empty();
    this.paintStatus();
  }

  private statusEl: HTMLElement | null = null;

  private paintStatus(): void {
    if (this.statusEl === null) return;
    this.statusEl.empty();
    this.statusEl.createSpan({
      cls: `scdb-app-state scdb-app-state--${this.state}`,
      text: STATE_TEXT[this.state],
    });
    if (this.detail !== "") {
      this.statusEl.createSpan({ cls: "scdb-muted", text: ` ${this.detail}` });
    }
  }

  /**
   * Built with `createEl` rather than Preact.
   *
   * The frame must not be re-created by a re-render: replacing the iframe
   * element restarts the app and throws away whatever it was showing, which is
   * exactly what a status update must not do. Keeping the chrome as plain DOM
   * makes that impossible rather than merely unlikely.
   */
  private paint(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("scdb-root");

    const bar = root.createDiv({ cls: "scdb-app-bar" });
    bar.createSpan({ cls: "scdb-app-bar__title", text: this.getDisplayText() });
    this.statusEl = bar.createSpan({ cls: "scdb-app-bar__status" });

    const actions = bar.createDiv({ cls: "scdb-app-bar__actions" });

    const runButton = actions.createEl("button", { cls: "mod-cta", text: "Run" });
    runButton.addEventListener("click", () => this.run());

    const stopButton = actions.createEl("button", { cls: "scdb-control", text: "Stop" });
    stopButton.addEventListener("click", () => this.stop());

    if (!this.scratchpad) {
      const open = actions.createEl("button", { cls: "scdb-control", text: "Open note" });
      open.addEventListener("click", () => this.plugin.openNote(this.path));

      const reload = actions.createEl("button", { cls: "scdb-control", text: "Reload from note" });
      reload.addEventListener("click", () => void this.reloadFromNote());
    }

    if (this.scratchpad) {
      const editor = root.createEl("textarea", {
        cls: "scdb-app-editor scdb-mono",
        attr: { spellcheck: "false", "aria-label": "Scratchpad source" },
      });
      editor.value = this.source;
      editor.addEventListener("input", () => {
        this.source = editor.value;
      });

      root.createEl("p", {
        cls: "scdb-muted",
        text:
          "Reads every indexed note type. It cannot change a note, reach the network or touch the filesystem, and nothing here is saved — copy it into an app note to keep it.",
      });
    }

    this.frameHost = root.createDiv({ cls: "scdb-app-host" });
    this.paintStatus();
  }

  /** Re-read the note, in case it was edited while the app was running. */
  private async reloadFromNote(): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    const assessment = await this.plugin.assessApp(file);
    if (assessment.needsConsent) {
      new Notice("This app now asks for more than you allowed. Run it from the Apps board to review.");
      return;
    }
    this.manifest = assessment.manifest;
    this.source = assessment.manifest.source;
    this.run();
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("scdb-root");
    this.paint();
    // §5.13: re-inject theme variables when the theme changes, so an app does
    // not sit there in yesterday's colours.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.frameHost !== null) this.session?.refreshTheme(this.frameHost);
      }),
    );
  }

  override async onClose(): Promise<void> {
    this.stop();
    render(null, this.contentEl);
    this.contentEl.empty();
  }
}
