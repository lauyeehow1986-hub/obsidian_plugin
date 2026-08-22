/**
 * Governance gates (CLAUDE.md §5.2, §5.5).
 *
 * Gates are what turn a task tracker into a research-data-governance
 * instrument, so the design principle here is: **a gate that cannot be
 * evaluated refuses.** Never pass on a field we could not read, never treat a
 * mistyped path as satisfied, and always return a reason a human can act on.
 *
 * Two halves, deliberately separated:
 *
 *  1. `buildGateContext` materialises a request into a flat, enumerable set of
 *     addressable values — including derived ones like `..._in_future` and
 *     `..._signed`. It is the only place that knows about evidence semantics.
 *  2. The evaluator is dumb: a path, optionally an operator and a literal. No
 *     arbitrary expressions, no function calls, nothing a spec file could use
 *     to reach outside the values offered to it.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp, toVaultDate } from "../time/dates";
import { evidenceFor, type RequestNote } from "./request";
import type { GateSpec, WorkflowSpec } from "./workflow";

export type GateValue = string | number | boolean | null;

export interface ContextEntry {
  value: GateValue;
  /** Why a derived value is what it is, used to build a useful refusal. */
  note?: string;
}

export type GateContext = Map<string, ContextEntry>;

const MAX_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): GateValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return toVaultDate(value.getTime());
  return undefined;
}

/**
 * Flatten frontmatter into dotted paths. Arrays contribute `.length` but are
 * not descended into: a gate should not be able to say `evidence[2].via`,
 * because a rule that depends on the position of a list entry is not a rule
 * anyone can maintain.
 */
function flatten(value: unknown, prefix: string, out: GateContext, depth: number): void {
  if (depth > MAX_DEPTH) return;

  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, { value: value.length });
    out.set(prefix, { value: value.length > 0 });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, out, depth + 1);
    }
    return;
  }
  const s = scalar(value);
  if (s !== undefined && prefix !== "") out.set(prefix, { value: s });
}

/**
 * Build everything a gate may address for this request, at this instant.
 *
 * Derived keys, all documented because a spec author has to be able to guess them:
 *
 *  - `<path>.length`      — for any list.
 *  - `<path>_in_future`   — for any readable date. False when the date is absent.
 *  - `<path>_in_past`     — the converse.
 *  - `governance.<x>_signed`    — the instrument `governance.<x>` has
 *    `status: signed` **and** a non-verbal evidence record for `<x>_signed`.
 *  - `governance.<x>_satisfied` — as above, or `waived` / `not-required`.
 *  - `evidence.<claim>`     — a non-verbal evidence record exists.
 *  - `evidence.<claim>.any` — any record exists, verbal included.
 */
export function buildGateContext(request: RequestNote, now: number): GateContext {
  const ctx: GateContext = new Map();
  flatten(request.raw, "", ctx, 0);

  // Date-derived booleans, over whatever the flatten pass found.
  for (const [path, entry] of [...ctx]) {
    if (path.endsWith(".length")) continue;
    const at = parseTimestamp(entry.value);
    if (at === null) continue;
    const future = at > now;
    const shown = `${path} is ${toVaultDate(at)}`;
    ctx.set(`${path}_in_future`, {
      value: future,
      note: future ? shown : `${shown}, which has passed`,
    });
    ctx.set(`${path}_in_past`, {
      value: !future,
      note: future ? `${shown}, which is still in the future` : shown,
    });
  }

  // Evidence records.
  for (const record of request.evidence) {
    const key = `evidence.${record.claim}`;
    if (record.hard) ctx.set(key, { value: true });
    else if (!ctx.has(key)) {
      ctx.set(key, {
        value: false,
        note: `the only evidence for ${record.claim} is ${record.via ?? "unrecorded"}, which cannot satisfy a gate on its own`,
      });
    }
    ctx.set(`${key}.any`, { value: true });
  }

  // Governance instruments: an object under `governance` carrying a `status`.
  const governance = request.raw["governance"];
  if (isRecord(governance)) {
    for (const [name, instrument] of Object.entries(governance)) {
      if (!isRecord(instrument)) continue;
      const status = typeof instrument["status"] === "string" ? instrument["status"].trim() : "";
      if (status === "") continue;

      const claim = `${name}_signed`;
      const backed = evidenceFor(request, claim).some((e) => e.hard);
      const signed = status === "signed";

      ctx.set(`governance.${name}_signed`, {
        value: signed && backed,
        note: !signed
          ? `${name} status is "${status}"`
          : backed
            ? undefined
            : `${name} status is "signed" but no evidence record for \`${claim}\` backs it`,
      });
      ctx.set(`governance.${name}_satisfied`, {
        value: (signed && backed) || status === "waived" || status === "not-required",
        note: `${name} status is "${status}"`,
      });
    }
  }

  return ctx;
}

// --- the expression evaluator ------------------------------------------------

type Operator = "==" | "!=" | ">=" | "<=" | ">" | "<";

const ATOM_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

function parseLiteral(text: string): GateValue {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

/** Present and non-empty. A numeric 0 counts as present — it is a value, not a blank. */
function truthy(value: GateValue): boolean {
  return !(value === null || value === false || value === "");
}

function describeValue(value: GateValue | undefined): string {
  if (value === undefined) return "not set";
  if (value === null) return "empty";
  if (typeof value === "string") return value === "" ? "empty" : `"${value}"`;
  return String(value);
}

function compare(left: GateValue, op: Operator, right: GateValue): boolean {
  if (op === "==" || op === "!=") {
    const equal =
      typeof left === typeof right ? left === right : String(left ?? "") === String(right ?? "");
    return op === "==" ? equal : !equal;
  }

  // Ordering: numbers first, then dates, and nothing else. Comparing two
  // arbitrary strings with `>` would produce a confident, meaningless answer.
  let a: number | null = typeof left === "number" ? left : null;
  let b: number | null = typeof right === "number" ? right : null;
  if (a === null || b === null) {
    a = parseTimestamp(left);
    b = parseTimestamp(right);
  }
  if (a === null || b === null) return false;

  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
}

export interface AtomResult {
  atom: string;
  ok: boolean;
  /** Plain English, ready to show: "governance.irb_ref is not set". */
  reason: string;
}

/** Evaluate one gate atom against a context. Unreadable means false, never true. */
export function evaluateAtom(atom: string, ctx: GateContext): AtomResult {
  const text = atom.trim();
  if (text === "") return { atom, ok: false, reason: "the gate has an empty condition" };

  const match = ATOM_RE.exec(text);
  const path = (match ? match[1]! : text).trim();
  const entry = ctx.get(path);

  if (!match) {
    const ok = entry !== undefined && truthy(entry.value);
    return {
      atom,
      ok,
      reason: ok ? `${path} is set` : (entry?.note ?? `${path} is ${describeValue(entry?.value)}`),
    };
  }

  const op = match[2] as Operator;
  const expected = parseLiteral(match[3]!);
  if (entry === undefined) {
    return { atom, ok: false, reason: `${path} is not set, so it cannot be ${op} ${describeValue(expected)}` };
  }

  const ok = compare(entry.value, op, expected);
  return {
    atom,
    ok,
    reason: ok
      ? `${path} is ${describeValue(entry.value)}`
      : `${path} is ${describeValue(entry.value)}, needs ${op} ${describeValue(expected)}`,
  };
}

export interface GateResult {
  gate: GateSpec;
  ok: boolean;
  /** Every atom, evaluated — the UI shows the passing ones too, so a user can see why. */
  atoms: AtomResult[];
  /** `gate.message` plus the specific reasons. Empty when the gate passes. */
  message: string;
}

function summarise(gate: GateSpec, failedRequire: AtomResult[], anyFailed: AtomResult[]): string {
  const parts: string[] = [];
  if (failedRequire.length > 0) {
    parts.push(failedRequire.map((a) => a.reason).join("; "));
  }
  if (anyFailed.length > 0) {
    parts.push(`needs one of: ${anyFailed.map((a) => a.atom).join(", ")}`);
  }
  return `${gate.message} (${parts.join("; ")})`;
}

/** Evaluate one gate. */
export function evaluateGate(gate: GateSpec, ctx: GateContext): GateResult {
  const required = gate.require.map((atom) => evaluateAtom(atom, ctx));
  const alternatives = gate.requireAny.map((atom) => evaluateAtom(atom, ctx));

  const failedRequire = required.filter((a) => !a.ok);
  const anySatisfied = alternatives.length === 0 || alternatives.some((a) => a.ok);
  const ok = failedRequire.length === 0 && anySatisfied;

  return {
    gate,
    ok,
    atoms: [...required, ...alternatives],
    message: ok ? "" : summarise(gate, failedRequire, anySatisfied ? [] : alternatives),
  };
}

/** Every gate guarding entry into `to`, evaluated against this request. */
export function evaluateGatesFor(
  spec: WorkflowSpec,
  request: RequestNote,
  to: string,
  now: number,
): GateResult[] {
  const gates = spec.gates.filter((g) => g.to === to);
  if (gates.length === 0) return [];
  const ctx = buildGateContext(request, now);
  return gates.map((gate) => evaluateGate(gate, ctx));
}
