import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  DIAGRAM_STATES,
  DIRECTIONS,
  EDGE_STYLES,
  NODE_SHAPES,
  emptyDiagram,
  orphanNodes,
  slugId,
  type DiagramEdge,
  type DiagramNode,
  type DiagramSpec,
} from "../domain/diagram/diagram";
import { mermaidSource, renderDiagram, resolvePalette } from "../services/diagramRender";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

export const DIAGRAM_VIEW_TYPE = "scdb-diagram-view";

/** How long to sit still before re-rendering the preview. */
const PREVIEW_DEBOUNCE_MS = 250;

interface PanelProps {
  plugin: ScdbCockpitPlugin;
  view: DiagramView;
  file: TFile | null;
  initial: DiagramSpec;
  problems: string[];
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <label class="scdb-field">
      <span class="scdb-field__label">{label}</span>
      {children}
    </label>
  );
}

function NodeRow({
  node,
  onChange,
  onRemove,
}: {
  node: DiagramNode;
  onChange: (next: DiagramNode) => void;
  onRemove: () => void;
}) {
  return (
    <tr>
      <td>
        <input
          type="text"
          value={node.label}
          aria-label={`Label for ${node.id}`}
          onInput={(event) => onChange({ ...node, label: event.currentTarget.value })}
        />
      </td>
      <td>
        <select
          value={node.shape}
          aria-label={`Shape for ${node.id}`}
          onChange={(event) =>
            onChange({ ...node, shape: event.currentTarget.value as DiagramNode["shape"] })
          }
        >
          {NODE_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {shape}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          value={node.state}
          aria-label={`State for ${node.id}`}
          onChange={(event) =>
            onChange({ ...node, state: event.currentTarget.value as DiagramNode["state"] })
          }
        >
          {DIAGRAM_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </td>
      <td class="scdb-muted scdb-num">{node.id}</td>
      <td>
        <button type="button" class="scdb-icon-button" aria-label={`Remove ${node.label}`} onClick={onRemove}>
          ✕
        </button>
      </td>
    </tr>
  );
}

function EdgeRow({
  edge,
  nodes,
  onChange,
  onRemove,
}: {
  edge: DiagramEdge;
  nodes: DiagramNode[];
  onChange: (next: DiagramEdge) => void;
  onRemove: () => void;
}) {
  const options = nodes.map((node) => (
    <option key={node.id} value={node.id}>
      {node.label || node.id}
    </option>
  ));
  return (
    <tr>
      <td>
        <select
          value={edge.from}
          aria-label="From"
          onChange={(event) => onChange({ ...edge, from: event.currentTarget.value })}
        >
          {options}
        </select>
      </td>
      <td>
        <select
          value={edge.to}
          aria-label="To"
          onChange={(event) => onChange({ ...edge, to: event.currentTarget.value })}
        >
          {options}
        </select>
      </td>
      <td>
        <input
          type="text"
          value={edge.label}
          aria-label="Arrow label"
          onInput={(event) => onChange({ ...edge, label: event.currentTarget.value })}
        />
      </td>
      <td>
        <select
          value={edge.style}
          aria-label="Arrow style"
          onChange={(event) =>
            onChange({ ...edge, style: event.currentTarget.value as DiagramEdge["style"] })
          }
        >
          {EDGE_STYLES.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </td>
      <td>
        <button type="button" class="scdb-icon-button" aria-label="Remove arrow" onClick={onRemove}>
          ✕
        </button>
      </td>
    </tr>
  );
}

/** The live Mermaid preview, rendered by core Mermaid and lifted in. */
function Preview({
  plugin,
  view,
  spec,
}: {
  plugin: ScdbCockpitPlugin;
  view: DiagramView;
  spec: DiagramSpec;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const target = host.current;
      if (target === null) return;
      if (spec.nodes.length === 0) {
        target.empty();
        setError("");
        return;
      }
      void renderDiagram(plugin.app, view, spec, resolvePalette(target))
        .then((rendered) => {
          if (cancelled || host.current === null) return;
          host.current.empty();
          // The SVG comes from core Mermaid over content we escaped ourselves
          // in `domain/diagram/mermaid`; it is appended as a node, never as
          // markup, so nothing here goes near innerHTML (§8).
          host.current.appendChild(rendered.svg);
          setError("");
        })
        .catch((failure: unknown) => {
          if (cancelled) return;
          setError(failure instanceof Error ? failure.message : String(failure));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [plugin, view, spec]);

  return (
    <div class="scdb-diagram__preview">
      {error !== "" && <p class="scdb-state--overdue">{error}</p>}
      {spec.nodes.length === 0 ? (
        <p class="scdb-muted">
          Nothing to draw yet. Add a box on the left, or close this and use one of the “Draw…”
          commands to generate a diagram from the workflow spec or from a request.
        </p>
      ) : (
        <div ref={host} class="scdb-diagram__canvas" />
      )}
    </div>
  );
}

function DiagramPanel({ plugin, view, file, initial, problems }: PanelProps) {
  const [spec, setSpec] = useState<DiagramSpec>(initial);
  const [saved, setSaved] = useState(() => JSON.stringify(initial));
  const [busy, setBusy] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSpec(initial);
    setSaved(JSON.stringify(initial));
  }, [initial]);

  const dirty = JSON.stringify(spec) !== saved;
  const orphans = useMemo(() => orphanNodes(spec), [spec]);

  const run = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy(label);
      try {
        const message = await action();
        if (message !== "") new Notice(`SCDB: ${message}`, 6000);
      } catch (error) {
        new Notice(`SCDB: ${error instanceof Error ? error.message : String(error)}`, 8000);
      } finally {
        setBusy("");
      }
    },
    [],
  );

  const save = useCallback(async () => {
    if (file === null) return "";
    await plugin.diagrams.save(file, spec);
    setSaved(JSON.stringify(spec));
    return `saved ${file.basename}.`;
  }, [file, plugin, spec]);

  const addNode = () => {
    const taken = new Set(spec.nodes.map((node) => node.id));
    const label = `Step ${spec.nodes.length + 1}`;
    setSpec({
      ...spec,
      nodes: [...spec.nodes, { id: slugId(label, taken), label, shape: "box", state: "none", note: "" }],
    });
  };

  const addEdge = () => {
    const first = spec.nodes[0];
    const second = spec.nodes[1] ?? first;
    if (first === undefined || second === undefined) return;
    setSpec({
      ...spec,
      edges: [...spec.edges, { from: first.id, to: second.id, label: "", style: "solid" }],
    });
  };

  /** Removing a node takes its arrows with it, or the note stops parsing. */
  const removeNode = (id: string) =>
    setSpec({
      ...spec,
      nodes: spec.nodes.filter((node) => node.id !== id),
      edges: spec.edges.filter((edge) => edge.from !== id && edge.to !== id),
    });

  return (
    <div class="scdb-diagram" ref={root}>
      <header class="scdb-diagram__head">
        <div class="scdb-diagram__meta">
          <Field label="Title">
            <input
              type="text"
              value={spec.title}
              onInput={(event) => setSpec({ ...spec, title: event.currentTarget.value })}
            />
          </Field>
          <Field label="Direction">
            <select
              value={spec.direction}
              onChange={(event) =>
                setSpec({ ...spec, direction: event.currentTarget.value as DiagramSpec["direction"] })
              }
            >
              {DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {direction}
                </option>
              ))}
            </select>
          </Field>
          {spec.source !== "hand" && (
            <span
              class="scdb-chip"
              title={`Generated from ${spec.generatedFrom || "vault data"} on ${spec.generatedAt || "an unrecorded date"}. Redraw rather than hand-editing, or the picture and the data drift apart.`}
            >
              {spec.source} · {spec.generatedFrom || "unknown source"}
            </span>
          )}
        </div>

        <div class="scdb-diagram__actions">
          <button
            type="button"
            class="mod-cta"
            disabled={file === null || !dirty || busy !== ""}
            onClick={() => void run("save", save)}
          >
            {dirty ? "Save" : "Saved"}
          </button>
          {spec.source !== "hand" && (
            <button
              type="button"
              class="scdb-control"
              disabled={busy !== ""}
              title="Rebuild this diagram from the data it was generated from."
              onClick={() =>
                void run("redraw", async () => {
                  const fresh = await plugin.redrawDiagram(spec);
                  if (fresh === null) {
                    return `could not find ${spec.generatedFrom || "what this was generated from"} to redraw from.`;
                  }
                  setSpec(fresh);
                  return "redrawn — save to keep it.";
                })
              }
            >
              Redraw
            </button>
          )}
          <button
            type="button"
            class="scdb-control"
            disabled={file === null || spec.nodes.length === 0 || busy !== ""}
            title="Write an .svg beside this note, replacing the previous one."
            onClick={() =>
              void run("svg", async () => {
                if (file === null) return "";
                const rendered = await renderDiagram(
                  plugin.app,
                  view,
                  spec,
                  resolvePalette(root.current ?? document.body),
                );
                const out = await plugin.diagrams.saveSvg(file, spec, rendered.text);
                return `wrote ${out.path}.`;
              })
            }
          >
            Save SVG
          </button>
          <button
            type="button"
            class="mod-cta"
            disabled={spec.nodes.length === 0 || busy !== ""}
            title="Rasterise at 3x and put it on the clipboard, ready to paste into a slide."
            onClick={() =>
              void run("clipboard", async () => {
                const outcome = await plugin.diagrams.copyPng(
                  view,
                  root.current ?? document.body,
                  spec,
                  3,
                );
                return outcome.ok ? "PNG copied — paste it into the slide." : outcome.why;
              })
            }
          >
            Copy PNG
          </button>
          {([2, 3] as const).map((scale) => (
            <button
              key={scale}
              type="button"
              class="scdb-control"
              disabled={spec.nodes.length === 0 || busy !== ""}
              title={`Write a PNG at ${scale}x into the exports folder.`}
              onClick={() =>
                void run("png", async () => {
                  const out = await plugin.diagrams.savePng(
                    view,
                    root.current ?? document.body,
                    spec,
                    scale,
                  );
                  return `wrote ${out.path}.`;
                })
              }
            >
              PNG {scale}×
            </button>
          ))}
          <button
            type="button"
            class="scdb-control"
            disabled={spec.nodes.length === 0 || busy !== ""}
            title="Put the Mermaid source on the clipboard."
            onClick={() =>
              void run("source", async () => {
                await navigator.clipboard.writeText(mermaidSource(spec));
                return "Mermaid source copied.";
              })
            }
          >
            Copy source
          </button>
        </div>
      </header>

      {problems.length > 0 && (
        <div class="scdb-warning">
          <strong>{count(problems.length, "problem")} reading this note</strong>
          <ul class="scdb-diagram__problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div class="scdb-diagram__body">
        <section class="scdb-diagram__editor">
          <h3>
            Boxes <span class="scdb-muted scdb-num">{count(spec.nodes.length, "box", "boxes")}</span>
          </h3>
          <table class="scdb-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Shape</th>
                <th>State</th>
                <th>Id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {spec.nodes.map((node, index) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  onChange={(next) =>
                    setSpec({
                      ...spec,
                      nodes: spec.nodes.map((existing, i) => (i === index ? next : existing)),
                    })
                  }
                  onRemove={() => removeNode(node.id)}
                />
              ))}
            </tbody>
          </table>
          <button type="button" class="scdb-control" onClick={addNode}>
            Add box
          </button>

          <h3>
            Arrows <span class="scdb-muted scdb-num">{count(spec.edges.length, "arrow")}</span>
          </h3>
          {spec.nodes.length < 1 ? (
            <p class="scdb-muted">Add a box before drawing an arrow.</p>
          ) : (
            <>
              <table class="scdb-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Label</th>
                    <th>Style</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {spec.edges.map((edge, index) => (
                    <EdgeRow
                      key={`${edge.from}-${edge.to}-${index}`}
                      edge={edge}
                      nodes={spec.nodes}
                      onChange={(next) =>
                        setSpec({
                          ...spec,
                          edges: spec.edges.map((existing, i) => (i === index ? next : existing)),
                        })
                      }
                      onRemove={() =>
                        setSpec({ ...spec, edges: spec.edges.filter((_, i) => i !== index) })
                      }
                    />
                  ))}
                </tbody>
              </table>
              <button type="button" class="scdb-control" onClick={addEdge}>
                Add arrow
              </button>
            </>
          )}

          {orphans.length > 0 && (
            <p class="scdb-muted">
              {count(orphans.length, "box", "boxes")} with no arrow in or out:{" "}
              {orphans.map((node) => node.label).join(", ")}.
            </p>
          )}
        </section>

        <section class="scdb-diagram__pane">
          <h3>Preview</h3>
          <Preview plugin={plugin} view={view} spec={spec} />
        </section>
      </div>
    </div>
  );
}

export class DiagramView extends ItemView {
  private path = "";
  /** A spec handed over by the writer, used once, before the cache catches up. */
  private pending: DiagramSpec | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return DIAGRAM_VIEW_TYPE;
  }

  override getDisplayText(): string {
    const file = this.file();
    return file === null ? "Diagram" : `Diagram: ${file.basename}`;
  }

  override getIcon(): string {
    return "workflow";
  }

  private file(): TFile | null {
    if (this.path === "") return null;
    const found = this.plugin.app.vault.getAbstractFileByPath(this.path);
    return found instanceof TFile ? found : null;
  }

  /**
   * Point the pane at a diagram note.
   *
   * **Deliberately not `getState`/`setState`.** Overriding those is the obvious
   * way to make the pane survive a restart, and it is what this view did first:
   * the result was a view whose container Obsidian never attached, so the pane
   * opened blank with no error anywhere. Carrying our own key in the persisted
   * view state puts us in the middle of the workspace's own serialisation, and
   * this pane is a workbench rather than a document — losing it on restart
   * costs one command. `CockpitView` takes the same shape for the same reason.
   */
  setFile(file: TFile, spec?: DiagramSpec): void {
    this.path = file.path;
    // A spec is passed in when the caller has just written the note: Obsidian's
    // metadata cache is asynchronous, so a note created a moment ago is not in
    // it yet and reading it back returns "no frontmatter". The report exporter
    // and C1's impact report hit the same thing; the answer each time is to
    // hand over the object rather than look it up again.
    this.pending = spec ?? null;
    this.refresh();
  }

  refresh(): void {
    const file = this.file();
    const parsed = file === null || this.pending !== null ? null : this.plugin.diagrams.read(file);
    const initial = this.pending ?? parsed?.spec ?? emptyDiagram();
    this.pending = null;
    render(
      <DiagramPanel
        plugin={this.plugin}
        view={this}
        file={file}
        initial={initial}
        problems={
          file === null
            ? ["This pane is not pointed at a diagram note. Open one from 89 Diagrams/."]
            : (parsed?.problems ?? [])
        }
      />,
      this.contentEl,
    );
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("scdb-root");
    this.refresh();
  }

  override async onClose(): Promise<void> {
    render(null, this.contentEl);
  }
}
