import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";

import { LANGUAGE_LABELS, type RunLanguage } from "../domain/compute/block";
import { formatDuration } from "../domain/compute/outcome";
import type { EnvEntry, StreamName } from "../domain/compute/session";
import {
  InterpreterSession,
  SESSION_STATE_LABELS,
  type CellResult,
  type SessionFigure,
  type SessionState,
} from "../services/interpreterSession";
import { ConsoleLog } from "./consoleLog";
import type ScdbCockpitPlugin from "../main.js";

export const CONSOLE_VIEW_TYPE = "scdb-console-view";

/** Kept in step with `revokeFigures`; an object URL left behind is a leak. */
const FIGURE_LIMIT = 24;

/**
 * The interpreter console (§7 F2).
 *
 * §7 F2 asks for four things — a console pane, an environment list, a plot
 * pane and a visible busy state — with restart as a first-class action. They
 * are all here, and the decisions worth knowing about are these:
 *
 * **Opening this pane starts nothing.** An interpreter is spawned by the first
 * Run, or by Start. Rule 12 is about note content and this harness is the
 * plugin's own, but a pane that silently launches a process when a workspace
 * is restored is a surprise, and surprise is the thing rule 12 is against.
 *
 * **Nothing here reaches the vault.** No run record, no ledger row, no note
 * written — §5.12 is explicit that "exploratory console lines do not" log, and
 * a ledger nobody can read is not a ledger. The consequence is deliberate and
 * is said out loud in the empty state: to keep a result, put the code in a
 * block and run it (F1), which produces a record naming the interpreter, the
 * hash of what ran and the data version.
 *
 * **One session at a time, and switching language ends the other one.** Two
 * live interpreters in one pane would need two environment panes, two plot
 * panes and two busy states to stay honest about which was which. Switching
 * says in the transcript that the variables are gone, rather than leaving
 * somebody to work it out from an environment pane that emptied itself.
 *
 * Built with `createEl` rather than Preact, like `AppView`: a transcript is
 * append-only, and re-rendering it on every chunk of output would discard the
 * selection and the scroll position of whoever was reading it.
 *
 * Deliberately no `getState`/`setState` — see the note on `DiagramView` for
 * what carrying our own key in the workspace serialisation did to that pane.
 */
export class ConsoleView extends ItemView {
  private language: RunLanguage = "python";
  private session: InterpreterSession | null = null;
  private state: SessionState = "stopped";
  private detail = "";
  private busySince = 0;

  private log: ConsoleLog | null = null;
  private stateEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private envEl: HTMLElement | null = null;
  private plotEl: HTMLElement | null = null;
  private input: HTMLTextAreaElement | null = null;
  private actions: HTMLElement | null = null;
  private languageBar: HTMLElement | null = null;

  private readonly history: string[] = [];
  private historyAt = 0;
  private readonly figureUrls: string[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return CONSOLE_VIEW_TYPE;
  }

  /**
   * A title that does not move.
   *
   * It named the language at first, which meant switching had to ask Obsidian
   * to redraw the tab header — an API that is not in the typings for the
   * version this targets, and §3 says to avoid new API surface without a
   * fallback. The language is on the toolbar a few pixels below, where it is
   * more useful anyway.
   */
  override getDisplayText(): string {
    return "Interpreter console";
  }

  override getIcon(): string {
    return "terminal";
  }

  // --- what the plugin calls ------------------------------------------------

  /** Point the pane at a language without running anything. */
  use(language: RunLanguage): void {
    if (language === this.language) return;
    this.switchTo(language);
  }

  /**
   * Send code from a note.
   *
   * The source is echoed into the transcript as it is sent, so what ran is on
   * screen next to what it printed — which is the console's version of "show
   * what will run" and the reason a second confirming dialog would be noise
   * here: the block is one the person just pointed at, in a note they are
   * looking at, and nothing this produces touches the vault.
   */
  send(language: RunLanguage, source: string, label: string): void {
    if (language !== this.language) this.switchTo(language);
    this.log?.append("note", `${label}\n`);
    void this.runSource(source);
  }

  // --- session --------------------------------------------------------------

  private ensureSession(): InterpreterSession {
    if (this.session !== null) return this.session;
    this.session = new InterpreterSession(this.language, () => this.plugin.computeSettings(), {
      onState: (state, detail) => this.onState(state, detail),
      onText: (stream, text) => this.onText(stream, text),
      onCell: (result) => this.onCell(result),
      onEnvironment: (rows) => this.renderEnvironment(rows),
    });
    return this.session;
  }

  private switchTo(language: RunLanguage): void {
    const had = this.session !== null && this.state !== "stopped" && this.state !== "failed";
    this.session?.stop();
    this.session = null;
    this.language = language;
    this.state = "stopped";
    this.detail = "";
    this.renderEnvironment([]);
    if (had) {
      this.log?.append(
        "note",
        `Switched to ${LANGUAGE_LABELS[language]}. The other session ended, so its variables are gone.\n`,
      );
    }
    this.paintBar();
    this.paintState();
  }

  private async runSource(source: string): Promise<void> {
    const code = source.replace(/\s+$/u, "");
    if (code === "") return;

    const session = this.ensureSession();
    const blockers = session.blockers();
    if (blockers.length > 0) {
      this.log?.append("stderr", `${blockers.join(" ")}\n`);
      return;
    }

    this.log?.divider();
    this.log?.append("input", `${code}\n`);

    const result = await session.run(code);
    if (result.interrupted) {
      this.log?.append("note", "Stopped before it finished.\n");
    }
  }

  private onState(state: SessionState, detail: string): void {
    if (state === "busy" && this.state !== "busy") this.busySince = Date.now();
    this.state = state;
    this.detail = detail;
    this.paintState();
    this.paintBar();
  }

  private onText(stream: StreamName, text: string): void {
    this.log?.append(stream === "stderr" ? "stderr" : "stdout", text);
  }

  private onCell(result: CellResult): void {
    const bits = [formatDuration(result.durationMs)];
    if (result.status !== 0) bits.push("error");
    if (result.figures.length > 0) {
      bits.push(`${result.figures.length} figure${result.figures.length === 1 ? "" : "s"}`);
    }
    this.log?.append("result", `${bits.join(" · ")}\n`);
    if (result.figures.length > 0) this.addFigures(result.figures);
  }

  // --- panes ----------------------------------------------------------------

  private renderEnvironment(rows: EnvEntry[]): void {
    const host = this.envEl;
    if (host === null) return;
    host.empty();

    if (rows.length === 0) {
      host.createDiv({
        cls: "scdb-empty",
        text:
          this.state === "stopped"
            ? "No session running."
            : "Nothing defined yet — variables appear here as you make them.",
      });
      return;
    }

    const table = host.createEl("table", { cls: "scdb-table scdb-console__env" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of ["name", "type", "size"]) head.createEl("th", { text: label });

    const body = table.createEl("tbody");
    for (const row of rows) {
      const line = body.createEl("tr");
      // The summary is a tooltip rather than a column: it is the widest thing
      // here and this pane has to survive a 300px sidebar (§6).
      if (row.summary !== "") line.setAttribute("title", row.summary);
      line.createEl("td", { cls: "scdb-console__name", text: row.name });
      line.createEl("td", { cls: "scdb-muted", text: row.kind });
      line.createEl("td", { cls: "scdb-num", text: row.size });
    }
  }

  private addFigures(figures: SessionFigure[]): void {
    const host = this.plotEl;
    if (host === null) return;
    host.querySelector(".scdb-empty")?.remove();

    for (const figure of figures) {
      const url = URL.createObjectURL(new Blob([figure.bytes], { type: "image/png" }));
      this.figureUrls.unshift(url);

      const card = host.createDiv({ cls: "scdb-console__plot" });
      card.createEl("img", { attr: { src: url, alt: `Figure from cell ${figure.cell}` } });
      host.prepend(card);
    }

    while (host.childElementCount > FIGURE_LIMIT) {
      host.lastElementChild?.remove();
      const dropped = this.figureUrls.pop();
      if (dropped !== undefined) URL.revokeObjectURL(dropped);
    }
  }

  private revokeFigures(): void {
    for (const url of this.figureUrls) URL.revokeObjectURL(url);
    this.figureUrls.length = 0;
    if (this.plotEl !== null) {
      this.plotEl.empty();
      this.plotEl.createDiv({ cls: "scdb-empty", text: "Plots appear here." });
    }
  }

  // --- chrome ---------------------------------------------------------------

  private paintState(): void {
    const chip = this.stateEl;
    if (chip !== null) {
      const running = this.state === "busy";
      const elapsed = running ? ` ${formatDuration(Date.now() - this.busySince)}` : "";
      chip.setText(`${SESSION_STATE_LABELS[this.state]}${elapsed}`);
      chip.className = `scdb-console__state scdb-console__state--${this.state}`;
    }
    if (this.detailEl !== null) {
      this.detailEl.setText(this.detail);
      this.detailEl.toggleClass("scdb-console__detail--bad", this.state === "failed");
    }
  }

  private paintBar(): void {
    const host = this.languageBar;
    if (host !== null) {
      host.empty();
      for (const language of ["r", "python"] as RunLanguage[]) {
        const button = host.createEl("button", {
          cls: `scdb-control scdb-console__lang${language === this.language ? " is-active" : ""}`,
          text: LANGUAGE_LABELS[language],
        });
        button.addEventListener("click", () => this.use(language));
      }
    }

    const actions = this.actions;
    if (actions === null) return;
    actions.empty();

    const idle = this.state === "stopped" || this.state === "failed";
    const start = actions.createEl("button", {
      cls: idle ? "mod-cta" : "scdb-control",
      text: idle ? "Start" : "Restart",
    });
    start.addEventListener("click", () => void this.startOrRestart());

    // Named for what it does. There is no interrupt on Windows — a signal to a
    // child process terminates it — so a button called "Interrupt" would be a
    // label that lies about losing your variables.
    const stop = actions.createEl("button", { cls: "scdb-control", text: "Stop session" });
    stop.disabled = idle;
    stop.addEventListener("click", () => {
      this.session?.stop();
      this.log?.append("note", "Session stopped.\n");
      this.renderEnvironment([]);
    });

    const clear = actions.createEl("button", { cls: "scdb-control", text: "Clear" });
    clear.setAttribute("aria-label", "Clear the transcript and the plots");
    clear.addEventListener("click", () => {
      this.log?.clear();
      this.revokeFigures();
    });
  }

  private async startOrRestart(): Promise<void> {
    const session = this.ensureSession();
    const restarting = this.state !== "stopped" && this.state !== "failed";
    if (restarting) {
      this.log?.append("note", "Restarting — the environment is cleared.\n");
      this.renderEnvironment([]);
    }
    const ok = restarting ? await session.restart() : await session.start();
    if (ok) {
      this.log?.append("note", `${session.interpreter}\n`);
    } else {
      new Notice("SCDB: the interpreter did not start. The console says why.", 6000);
    }
  }

  private paint(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("scdb-root", "scdb-console");

    const bar = root.createDiv({ cls: "scdb-console__bar" });
    this.languageBar = bar.createDiv({ cls: "scdb-console__langs" });
    this.stateEl = bar.createSpan({ cls: "scdb-console__state" });
    this.detailEl = bar.createSpan({ cls: "scdb-console__detail" });
    this.actions = bar.createDiv({ cls: "scdb-console__actions" });

    const body = root.createDiv({ cls: "scdb-console__body" });
    const main = body.createDiv({ cls: "scdb-console__main" });

    const logHost = main.createDiv({ cls: "scdb-console__log" });
    this.log = new ConsoleLog(logHost);
    this.log.append(
      "note",
      `Nothing here is written to the vault — no run record, no ledger entry, no note. ` +
        `To keep a result, put the code in a block in a note and run it there.\n`,
    );

    const foot = main.createDiv({ cls: "scdb-console__foot" });
    const input = foot.createEl("textarea", {
      cls: "scdb-console__input scdb-mono",
      attr: { spellcheck: "false", rows: "4", "aria-label": "Code to run" },
    });
    this.input = input;
    input.addEventListener("keydown", (event) => this.onKey(event));

    const send = foot.createDiv({ cls: "scdb-console__send" });
    send.createSpan({
      cls: "scdb-muted",
      text: "Ctrl+Enter to run · Ctrl+↑ and Ctrl+↓ for what you ran before",
    });
    const run = send.createEl("button", { cls: "mod-cta", text: "Run" });
    run.addEventListener("click", () => this.runInput());

    const side = body.createDiv({ cls: "scdb-console__side" });

    const envSection = side.createDiv({ cls: "scdb-console__section" });
    const envHead = envSection.createDiv({ cls: "scdb-console__head" });
    setIcon(envHead.createSpan({ cls: "scdb-console__icon" }), "variable");
    envHead.createSpan({ text: "Environment" });
    this.envEl = envSection.createDiv({ cls: "scdb-console__envhost" });

    const plotSection = side.createDiv({ cls: "scdb-console__section" });
    const plotHead = plotSection.createDiv({ cls: "scdb-console__head" });
    setIcon(plotHead.createSpan({ cls: "scdb-console__icon" }), "line-chart");
    plotHead.createSpan({ text: "Plots" });
    this.plotEl = plotSection.createDiv({ cls: "scdb-console__plots" });

    this.renderEnvironment([]);
    this.plotEl.createDiv({ cls: "scdb-empty", text: "Plots appear here." });
    this.paintBar();
    this.paintState();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.runInput();
      return;
    }
    // Ctrl rather than a bare arrow: this is a multi-line editor, and stealing
    // Up would make a four-line cell impossible to edit.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && (event.ctrlKey || event.metaKey)) {
      if (this.history.length === 0) return;
      event.preventDefault();
      this.historyAt = Math.max(
        0,
        Math.min(this.history.length, this.historyAt + (event.key === "ArrowUp" ? -1 : 1)),
      );
      const input = this.input;
      if (input === null) return;
      input.value = this.history[this.historyAt] ?? "";
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  private runInput(): void {
    const input = this.input;
    if (input === null) return;
    const code = input.value;
    if (code.trim() === "") return;
    this.history.push(code.replace(/\s+$/u, ""));
    this.historyAt = this.history.length;
    input.value = "";
    void this.runSource(code);
  }

  override async onOpen(): Promise<void> {
    this.paint();
    // A busy state that does not move is indistinguishable from a frozen one,
    // which is the whole question a person has while waiting.
    this.registerInterval(
      window.setInterval(() => {
        if (this.state === "busy") this.paintState();
      }, 500),
    );
  }

  override async onClose(): Promise<void> {
    this.session?.stop();
    this.session = null;
    this.revokeFigures();
    this.contentEl.empty();
  }
}
