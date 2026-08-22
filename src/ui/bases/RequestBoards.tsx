import { BasesView, type QueryController } from "obsidian";
import { render, type ComponentChild } from "preact";
import type { RequestView } from "../../domain/request/holdup";
import type ScdbCockpitPlugin from "../../main.js";
import { AgeingBoard, HoldupBoard } from "../CockpitView";

/**
 * SCDB boards registered as first-class Bases view types (CLAUDE.md §7 A2b).
 *
 * The division of labour is the point. Bases owns the query — which notes, what
 * filters, and the toolbar the user already knows — and hands us the matching
 * entries. We own the maths it structurally cannot do: dwell from `history`,
 * who is blocking, SLA state, bounce counts.
 *
 * They render the *same* components as the cockpit's own boards, deliberately.
 * Two implementations of "how long has this been stuck" that could disagree is
 * exactly the drift this plugin exists to prevent.
 *
 * ── Why the classes are defined inside a function ──────────────────────────
 * `BasesView` does not exist before Obsidian 1.10, and `class X extends Y` is
 * evaluated when the module loads, not when the class is used. Written at the
 * top level this throws `Class extends value undefined` on an older Obsidian
 * and the whole plugin fails to load — not the Bases part, all of it. Our
 * `minAppVersion` is below 1.10 on purpose, so the definitions are deferred
 * into `registerRequestBoards`, which the caller only invokes once it has
 * confirmed the API is there. `npm run smoke` loads the bundle against an
 * Obsidian stub with no Bases and would catch a regression here.
 */

export const HOLDUP_VIEW_ID = "scdb-holdup";
export const AGEING_VIEW_ID = "scdb-ageing";

/**
 * Define and register both board view types.
 *
 * Only call this when `registerBasesView` exists; it dereferences `BasesView`.
 */
export function registerRequestBoards(plugin: ScdbCockpitPlugin): void {
  abstract class RequestBoardView extends BasesView {
    constructor(
      controller: QueryController,
      protected readonly containerEl: HTMLElement,
    ) {
      super(controller);
      // Our stylesheet is scoped to `.scdb-root`, and the button reset lives
      // there. Without this class every card collapses into a 30px control.
      this.containerEl.addClass("scdb-root");
    }

    protected abstract board(views: RequestView[]): ComponentChild;

    /**
     * Bases replaces `data` wholesale on every vault or config change, so views
     * are rebuilt rather than cached. Dwell depends on the current time anyway
     * (§5.1), so there is nothing worth keeping.
     */
    onDataUpdated(): void {
      const entries = this.data?.data ?? [];
      const paths = entries.map((entry) => entry.file.path);
      const views = plugin.index.viewsForPaths(paths, { now: Date.now() });

      if (paths.length > 0 && views.length === 0) {
        render(
          <p class="scdb-empty">
            None of these notes are SCDB requests. This view computes dwell and holdup from a
            request's <code>history</code>, so point the base at <code>type: scdb-request</code>.
          </p>,
          this.containerEl,
        );
        return;
      }

      render(this.board(views), this.containerEl);
    }

    override onunload(): void {
      // Preact keeps effects alive until told otherwise; the frame going away
      // is not an unmount.
      render(null, this.containerEl);
      this.containerEl.removeClass("scdb-root");
      super.onunload();
    }
  }

  /** Who is the holdup, grouped by person, so one chase-up covers several. */
  class HoldupBasesView extends RequestBoardView {
    type = HOLDUP_VIEW_ID;
    protected board(views: RequestView[]): ComponentChild {
      return <HoldupBoard views={views} plugin={plugin} />;
    }
  }

  /** Aged and breaching, worst first. */
  class AgeingBasesView extends RequestBoardView {
    type = AGEING_VIEW_ID;
    protected board(views: RequestView[]): ComponentChild {
      return <AgeingBoard views={views} plugin={plugin} />;
    }
  }

  plugin.registerBasesView(HOLDUP_VIEW_ID, {
    name: "SCDB holdup",
    icon: "user-round-x",
    factory: (controller, containerEl) => new HoldupBasesView(controller, containerEl),
  });

  plugin.registerBasesView(AGEING_VIEW_ID, {
    name: "SCDB ageing",
    icon: "alarm-clock",
    factory: (controller, containerEl) => new AgeingBasesView(controller, containerEl),
  });
}
