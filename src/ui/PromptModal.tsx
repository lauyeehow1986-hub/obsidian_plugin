/**
 * One-field prompt.
 *
 * Its own dialog rather than `window.prompt`: Electron does not implement
 * `prompt()`, so that path is a silent no-op in Obsidian rather than a
 * fallback. Shared because two features now need it — splitting a time entry
 * (§7 B2) and dating a completed obligation (§7 B3) — and a second copy would
 * be a second dialog to keep looking like the first.
 */

import type { App } from "obsidian";
import { useState } from "preact/hooks";
import { PreactModal } from "./PreactModal";

export interface PromptConfig {
  title: string;
  lede: string;
  label: string;
  initial: string;
  submitLabel: string;
  /** Rejects a value with a reason, shown under the field. Blank means fine. */
  validate?: (value: string) => string;
}

export class PromptModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly config: PromptConfig,
    private readonly resolve: (value: string | null) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <PromptForm
        {...this.config}
        onSubmit={(v) => this.finish(v)}
        onCancel={() => this.finish(null)}
      />
    );
  }

  override onOpen(): void {
    this.titleEl.setText(this.config.title);
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    // Dismissal is never consent: Escape and the X resolve null.
    if (!this.decided) this.resolve(null);
  }

  private finish(value: string | null): void {
    // Idempotent: a dialog can be submitted twice in one gesture, and the
    // second resolve would be silently dropped by the promise anyway. Saying
    // so here means the next reader does not have to work that out.
    if (this.decided) return;
    this.decided = true;
    this.resolve(value);
    this.close();
  }
}

function PromptForm({
  lede,
  label,
  initial,
  submitLabel,
  validate,
  onSubmit,
  onCancel,
}: PromptConfig & {
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const reason = trimmed === "" ? "" : (validate?.(trimmed) ?? "");
  const ready = trimmed !== "" && reason === "";

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">{lede}</p>
      <label class="scdb-field">
        <span class="scdb-field__label">{label}</span>
        <input
          type="text"
          autofocus
          value={value}
          onInput={(event) => setValue((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // `preventDefault` is load-bearing, not tidiness. Without it the
            // keypress submits, the modal closes, focus is restored to the
            // button that opened it, and Enter's default action then clicks
            // that button — so recording a completion immediately reopened the
            // dialog. Found by pressing Enter in Obsidian, not by a test.
            event.preventDefault();
            if (ready) onSubmit(trimmed);
          }}
        />
      </label>
      {reason !== "" && <p class="scdb-field__hint scdb-field__hint--problem">{reason}</p>}
      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" class="mod-cta" disabled={!ready} onClick={() => onSubmit(trimmed)}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function askText(app: App, config: PromptConfig): Promise<string | null> {
  return new Promise((resolve) => new PromptModal(app, config, resolve).open());
}
