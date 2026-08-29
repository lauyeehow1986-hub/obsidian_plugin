/**
 * The runtime handed to a vault app inside the sandbox (§5.13, §7 F3).
 *
 * **This file does not become part of `main.js`.** It is bundled separately
 * into an IIFE, and that bundle is carried as a *string* which the host injects
 * into the iframe's `srcdoc`. It is in its own directory for exactly that
 * reason: everything else under `src/` compiles into the plugin, and this
 * compiles into a page that runs on the other side of a security boundary.
 * Nothing here may import from `main.ts`, from `services/`, or from anything
 * that reaches Obsidian — there is no Obsidian on this side.
 *
 * What §5.13 requires it to provide, and why:
 *
 *  - **A pre-bound runtime.** `html` is `htm` already bound to Preact's `h`.
 *    App authors never wire the two together; that is ceremony with exactly
 *    one correct answer.
 *  - **A broker-backed context, never a live Obsidian object.** `useQuery`,
 *    `useNotes` and `useProposeWrite` are messages, not method calls. This is
 *    not merely a policy choice — structured clone cannot carry a live object
 *    across the frame boundary, so the ergonomic version is also the only
 *    version that exists.
 *  - **An error boundary at the mount point**, plus `onerror` and
 *    `unhandledrejection` forwarded to the host. §5.13 is careful about what
 *    that buys: a readable error box instead of a blank frame. It buys nothing
 *    at all against an infinite loop, which is the watchdog's problem.
 *
 * The same bundle serves the exported HTML page (§5.13, §7 F3): when a
 * snapshot is present it answers reads from the frozen data instead of the
 * broker, so an app given to a colleague behaves the same way with nobody's
 * vault behind it.
 */

import { Component, h, render, type ComponentChildren, type ComponentType } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

const PROTOCOL = 1;
/** A request the host never answers must fail readably rather than hang. */
const CALL_TIMEOUT_MS = 20_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

const pending = new Map<number, Pending>();
let nextId = 1;

interface SnapshotShape {
  rows: Record<string, unknown[]>;
  takenAt: string;
}

const globals = globalThis as unknown as {
  __scdbSnapshot?: SnapshotShape;
  __scdbRuntime?: unknown;
};

/** True in an exported page: reads are served from frozen data, writes refuse. */
const snapshot = globals.__scdbSnapshot;

function post(message: unknown): void {
  // The frame's origin is opaque (`sandbox` without `allow-same-origin`), so
  // "*" is the only target that can ever match. It is not a weakening: the
  // host verifies `event.source` against its own iframe rather than trusting
  // an origin string, and nothing in this page holds a secret to leak.
  parent.postMessage(message, "*");
}

function serveFromSnapshot(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!snapshot) return Promise.reject(new Error("No data available."));
  if (kind === "propose") {
    return Promise.reject(
      new Error(
        "This is an exported copy of the app with a snapshot of its data. It cannot change notes — open the app in Obsidian to do that.",
      ),
    );
  }
  const asked = Array.isArray(payload.types)
    ? (payload.types as unknown[]).filter((t): t is string => typeof t === "string")
    : Object.keys(snapshot.rows);
  const rows: unknown[] = [];
  for (const type of asked) rows.push(...(snapshot.rows[type] ?? []));
  return Promise.resolve({ rows, takenAt: snapshot.takenAt });
}

function call(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  if (snapshot) return serveFromSnapshot(kind, payload);

  return new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The plugin did not answer in time. It may be busy, or the pane may have been closed."));
    }, CALL_TIMEOUT_MS) as unknown as number;
    pending.set(id, { resolve, reject, timer });
    post({ scdb: PROTOCOL, id, kind, payload });
  });
}

if (!snapshot) {
  addEventListener("message", (event: MessageEvent) => {
    // Only the host may talk to this frame. Anything else — another frame, a
    // stray page — is not answered and not read.
    if (event.source !== parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (data === null || typeof data !== "object" || data.scdb !== PROTOCOL) return;

    if (data.kind === "ping") {
      post({ scdb: PROTOCOL, id: data.id, kind: "pong", payload: {} });
      return;
    }
    if (data.kind === "theme") {
      applyTheme(typeof data.css === "string" ? data.css : "");
      return;
    }

    const entry = typeof data.id === "number" ? pending.get(data.id) : undefined;
    if (entry === undefined) return;
    pending.delete(data.id as number);
    clearTimeout(entry.timer);
    if (data.ok === true) entry.resolve(data.data);
    else entry.reject(new Error(typeof data.error === "string" ? data.error : "Refused."));
  });
}

/**
 * Obsidian's theme variables, re-injected whenever the host says they changed.
 *
 * An iframe inherits no styling from its parent, and §6 requires a view to look
 * like part of Obsidian in whatever theme the work laptop is wearing. The host
 * sends a block of custom properties; this puts it in a style element of its
 * own so replacing it never disturbs the app's own CSS.
 */
function applyTheme(css: string): void {
  let style = document.getElementById("scdb-theme");
  if (style === null) {
    style = document.createElement("style");
    style.id = "scdb-theme";
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/* --------------------------------------------------------------- the hooks -- */

export interface QuerySpec {
  types?: string[];
  [extra: string]: unknown;
}

interface QueryState<T> {
  rows: T[];
  loading: boolean;
  error: string;
}

function useAsyncRows(kind: string, payload: Record<string, unknown>, key: string) {
  const [state, setState] = useState<QueryState<Record<string, unknown>>>({
    rows: [],
    loading: true,
    error: "",
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    call(kind, payload)
      .then((answer) => {
        if (!live) return;
        const rows = (answer as { rows?: unknown[] })?.rows ?? [];
        setState({ rows: rows as Record<string, unknown>[], loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({ rows: [], loading: false, error: messageOf(error) });
      });
    return () => {
      live = false;
    };
    // `key` is the serialised request: a new object literal every render must
    // not mean a new query every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** Rows for a query, through the broker. The manifest decides what comes back. */
function useQuery(spec: QuerySpec = {}) {
  const key = JSON.stringify(spec);
  return useAsyncRows("query", spec as Record<string, unknown>, key);
}

/** Every note of one type, unfiltered. The plain form of `useQuery`. */
function useNotes(type: string) {
  const key = JSON.stringify({ type });
  return useAsyncRows("notes", { types: [type] }, key);
}

/**
 * Offer a change to a note.
 *
 * The promise resolves when *you* confirm the change in Obsidian, and rejects
 * when you decline it or the manifest does not allow it. An app cannot tell
 * the difference between "refused" and "you said no", which is the correct
 * amount for it to know.
 */
function useProposeWrite() {
  return useCallback(proposeWrite, []);
}

/**
 * The imperative forms of the read hooks.
 *
 * `useProposeWrite` hands back a function because a write happens in response
 * to a click rather than during a render, and reads have exactly the same
 * need: an app that fetches something when a button is pressed cannot call a
 * hook to do it. Without these an app would have to fake it with state, or —
 * as the shipped overreach fixture did before this existed — call something
 * that is not there and report a JavaScript error as though it were a refusal.
 */
function query(spec: QuerySpec = {}): Promise<unknown> {
  return call("query", spec as Record<string, unknown>);
}

function notes(type: string): Promise<unknown> {
  return call("notes", { types: [type] });
}

function proposeWrite(proposal: {
  path: string;
  frontmatter: Record<string, unknown>;
  reason?: string;
}): Promise<unknown> {
  return call("propose", proposal as unknown as Record<string, unknown>);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}

/* ------------------------------------------------------- the error boundary -- */

class Boundary extends Component<{ children: ComponentChildren }, { error: string }> {
  override state = { error: "" };

  static override getDerivedStateFromError(error: unknown) {
    return { error: messageOf(error) };
  }

  override componentDidCatch(error: unknown): void {
    report(messageOf(error));
  }

  override render() {
    if (this.state.error !== "") {
      return h(
        "div",
        { class: "scdb-app-error" },
        h("strong", null, "This app stopped."),
        h("pre", null, this.state.error),
      );
    }
    return this.props.children;
  }
}

function report(message: string): void {
  if (snapshot) return;
  post({ scdb: PROTOCOL, id: 0, kind: "failed", payload: { message } });
}

addEventListener("error", (event: ErrorEvent) => report(event.message || "Script error."));
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) =>
  report(messageOf(event.reason)),
);

/* -------------------------------------------------------------- the mount -- */

function mount(component: ComponentType<Record<string, never>>): void {
  const root = document.getElementById("app");
  if (root === null) return;
  render(h(Boundary, null, h(component, {})), root);
}

/**
 * An error the boundary can never see: one thrown before anything mounted.
 *
 * The boundary only catches what happens *inside* a component. A syntax-level
 * failure in the app's own setup — a typo at the top of the file, an await
 * that rejects before the first render — would otherwise leave a blank frame
 * and nothing said anywhere, which is the exact failure §5.13 asks the
 * boundary to prevent. So the wrapper ends in this, and it does both halves:
 * paints something readable, and tells the host.
 */
function fail(error: unknown): void {
  const message = messageOf(error);
  report(message);
  const root = document.getElementById("app");
  if (root === null) return;
  render(
    h(
      "div",
      { class: "scdb-app-error" },
      h("strong", null, "This app did not start."),
      h("pre", null, message),
    ),
    root,
  );
}

globals.__scdbRuntime = {
  html,
  h,
  render,
  mount,
  fail,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useQuery,
  useNotes,
  useProposeWrite,
  query,
  notes,
  proposeWrite,
  /** Present only in an exported page. Lets an app say so on screen. */
  snapshotTakenAt: snapshot?.takenAt ?? "",
};

if (!snapshot) post({ scdb: PROTOCOL, id: 0, kind: "ready", payload: {} });
