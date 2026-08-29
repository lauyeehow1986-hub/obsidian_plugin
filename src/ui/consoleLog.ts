/**
 * The console transcript (§7 F2).
 *
 * Plain DOM, appended to. A console is an append-only log, so rebuilding it
 * from state on every chunk would be both wasteful and wrong: it would throw
 * away the selection somebody was in the middle of making and the scroll
 * position they had scrolled to.
 *
 * Three behaviours here are the difference between a console and a text box:
 *
 *  - **Consecutive output coalesces.** Chunks arrive on OS timing — a single
 *    `print` can arrive in two pieces and two prints can arrive in one — so an
 *    element per chunk would split lines at arbitrary points and give a
 *    ragged, wrongly-spaced transcript. Text appended to the block already
 *    open reads the way it was written.
 *
 *  - **Autoscroll only from the bottom.** Scrolling up to read something, and
 *    being yanked back down by output that arrived a moment later, makes long
 *    output impossible to read. Following happens only when already following.
 *
 *  - **Scrollback is capped.** A loop that prints for a minute would otherwise
 *    grow the document until the pane is unusable. The oldest entries go, and
 *    a line says how many, because output silently disappearing is worse than
 *    output that says it disappeared.
 *
 * Never `innerHTML` (§8): everything here is text, put into elements built
 * with `createEl`, so a cell that prints a `<script>` tag prints a script tag.
 */

export type LogKind = "input" | "stdout" | "stderr" | "result" | "note";

const KIND_CLASS: Record<LogKind, string> = {
  input: "scdb-console__in",
  stdout: "scdb-console__out",
  stderr: "scdb-console__err",
  result: "scdb-console__result",
  note: "scdb-console__note",
};

export class ConsoleLog {
  private trimmed = 0;
  private trimNotice: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly limit = 400,
  ) {}

  /** True when the reader is at the bottom and therefore following along. */
  private following(): boolean {
    const slack = this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight;
    return slack < 40;
  }

  append(kind: LogKind, text: string): void {
    if (text === "") return;
    const follow = this.following();

    const last = this.host.lastElementChild;
    const open =
      (kind === "stdout" || kind === "stderr") &&
      last instanceof HTMLElement &&
      last.dataset["kind"] === kind;

    if (open && last instanceof HTMLElement) {
      last.appendText(text);
    } else {
      const block = this.host.createEl("pre", { cls: `scdb-console__line ${KIND_CLASS[kind]}` });
      block.dataset["kind"] = kind;
      block.setText(text);
    }

    this.trim();
    if (follow) this.host.scrollTop = this.host.scrollHeight;
  }

  /** A rule between cells, so a long transcript is scannable. */
  divider(): void {
    const follow = this.following();
    this.host.createDiv({ cls: "scdb-console__divider" });
    this.trim();
    if (follow) this.host.scrollTop = this.host.scrollHeight;
  }

  clear(): void {
    this.host.empty();
    this.trimmed = 0;
    this.trimNotice = null;
  }

  private trim(): void {
    while (this.host.childElementCount > this.limit) {
      const first = this.host.firstElementChild;
      if (first === null || first === this.trimNotice) break;
      first.remove();
      this.trimmed += 1;
    }
    if (this.trimmed === 0) return;

    if (this.trimNotice === null || !this.trimNotice.isConnected) {
      this.trimNotice = this.host.createDiv({ cls: "scdb-console__trimmed" });
      this.host.prepend(this.trimNotice);
    }
    this.trimNotice.setText(
      `${this.trimmed.toLocaleString("en-GB")} earlier ${this.trimmed === 1 ? "entry" : "entries"} dropped to keep this pane usable.`,
    );
  }
}
