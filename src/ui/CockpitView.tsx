import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import type ScdbCockpitPlugin from "../main.js";

export const COCKPIT_VIEW_TYPE = "scdb-cockpit-view";

/**
 * A0 placeholder for the cockpit (§7 A3). It exists now to prove the whole
 * Preact + JSX + esbuild path works end to end before anything depends on it.
 */
function CockpitPanel({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const { mode, actor, schemaVersion } = plugin.settings;
  return (
    <div class="scdb-cockpit">
      <h2 class="scdb-cockpit__title">SCDB Cockpit</h2>
      <p class="scdb-cockpit__muted">
        Scaffold only. Request tracking arrives in A1.
      </p>
      <dl class="scdb-cockpit__facts">
        <dt>Mode</dt>
        <dd>{mode}</dd>
        <dt>Actor</dt>
        <dd>{actor || <span class="scdb-cockpit__muted">not set</span>}</dd>
        <dt>Settings schema</dt>
        <dd>v{schemaVersion}</dd>
        <dt>Core Bases</dt>
        <dd>{plugin.basesAvailable ? "available" : "not available"}</dd>
      </dl>
    </div>
  );
}

export class CockpitView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return COCKPIT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "SCDB Cockpit";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  override async onOpen(): Promise<void> {
    render(<CockpitPanel plugin={this.plugin} />, this.contentEl);
  }

  override async onClose(): Promise<void> {
    // Preact needs an explicit unmount or the tree leaks when the leaf closes.
    render(null, this.contentEl);
  }
}
