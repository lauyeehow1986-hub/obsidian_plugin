/**
 * The broker protocol (§5.13, §7 F3).
 *
 * An app cannot touch the vault. It asks, over `postMessage`, and this module
 * decides whether the question is one its manifest allows. §5.13 is blunt
 * about why the answer cannot simply be a live object: *"`App`, `Plugin`,
 * `Vault` and `adapter` are never passed into an app"* — handing over `app`
 * would hand over `app.vault.adapter`, which is arbitrary filesystem access,
 * and make the manifest decorative.
 *
 * Everything here is pure. The service (`services/appHost.ts`) owns the frame,
 * the ports and the timers; this owns the *rules*, so every refusal path is
 * unit-tested rather than reasoned about.
 *
 * **Messages arriving from the frame are untrusted input.** They come from
 * code the person may have been sent by someone else, so every field is
 * checked before it is read — `isAppRequest` is a validator, not a cast. A
 * malformed message is refused, never coerced into a plausible one.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { AppManifest } from "./manifest";

/** Bumped only if the message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export const REQUEST_KINDS = ["ready", "pong", "query", "notes", "propose", "failed"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export interface AppRequest {
  scdb: number;
  /** Correlates a reply with its request. `0` for messages that expect none. */
  id: number;
  kind: RequestKind;
  payload: Record<string, unknown>;
}

export type BrokerReply =
  | { scdb: number; id: number; ok: true; data: unknown }
  | { scdb: number; id: number; ok: false; error: string };

/** Host-initiated messages. Not replies — the frame answers `ping` with `pong`. */
export type HostMessage =
  | { scdb: number; kind: "ping"; id: number }
  | { scdb: number; kind: "theme"; css: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a message from the frame. Anything unexpected is simply not a request. */
export function isAppRequest(value: unknown): value is AppRequest {
  if (!isRecord(value)) return false;
  if (value.scdb !== PROTOCOL_VERSION) return false;
  if (typeof value.id !== "number" || !Number.isFinite(value.id)) return false;
  if (typeof value.kind !== "string") return false;
  if (!(REQUEST_KINDS as readonly string[]).includes(value.kind)) return false;
  return value.payload === undefined || isRecord(value.payload);
}

export type Authorisation<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Which note types a read may cover.
 *
 * An app asking for nothing in particular gets everything it was granted,
 * which is the common case — `useQuery({})` in an app declaring one type.
 * Asking for a type it was not granted is refused by name, because "not
 * permitted" without saying what would send the author to guess.
 */
export function authoriseQuery(
  payload: Record<string, unknown>,
  manifest: AppManifest,
): Authorisation<string[]> {
  const granted = manifest.capabilities.query;
  if (granted.length === 0) {
    return {
      ok: false,
      error:
        "This app is not granted read access to any note type. Add the types it needs under `capabilities.query` in its note, and it will ask you to confirm the change.",
    };
  }

  const raw = payload.types;
  const asked = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : typeof raw === "string"
      ? [raw]
      : [];

  if (asked.length === 0) return { ok: true, value: [...granted] };

  const refused = asked.filter((type) => !granted.includes(type));
  if (refused.length > 0) {
    return {
      ok: false,
      error: `This app is granted ${granted.join(", ")}. It asked for ${refused.join(", ")}, which is not in its manifest.`,
    };
  }
  return { ok: true, value: asked };
}

export interface WriteProposal {
  path: string;
  /** Keys to merge into the note's frontmatter. Unknown keys elsewhere survive (rule 8). */
  frontmatter: Record<string, unknown>;
  /** Why the app says this change should happen. Shown to the user verbatim. */
  reason: string;
}

/**
 * Fields an app may never propose, whatever its manifest says.
 *
 * `uid` is a note's immutable machine identity (§5.2) and everything durable
 * points at it. `type` decides which engine reads the note at all. `history`
 * is the append-only record every dwell and bounce figure is computed from
 * (§5.1) — an app rewriting it would not corrupt a number you could see, it
 * would corrupt the number a facility report is built on.
 *
 * These are refused rather than filtered out, so a proposal that quietly loses
 * half of itself never reaches the confirmation dialog.
 */
export const PROTECTED_FIELDS = ["uid", "type", "history"] as const;

export function authoriseWrite(
  payload: Record<string, unknown>,
  manifest: AppManifest,
): Authorisation<WriteProposal> {
  if (manifest.capabilities.write !== "propose") {
    return {
      ok: false,
      error:
        "This app is not granted write access. Set `capabilities.write: propose` in its note if it should be able to offer changes for you to confirm.",
    };
  }

  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (path === "") {
    return { ok: false, error: "The proposed change did not name a note." };
  }

  if (!isRecord(payload.frontmatter)) {
    return { ok: false, error: "The proposed change carried no frontmatter fields to set." };
  }
  const frontmatter = payload.frontmatter;
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) {
    return { ok: false, error: "The proposed change carried no frontmatter fields to set." };
  }

  const protectedKeys = keys.filter((key) =>
    (PROTECTED_FIELDS as readonly string[]).includes(key.split(".")[0] ?? key),
  );
  if (protectedKeys.length > 0) {
    return {
      ok: false,
      error: `No app may change ${protectedKeys.join(", ")} — a note's identity and its history are what every computed figure is derived from.`,
    };
  }

  return {
    ok: true,
    value: {
      path,
      frontmatter,
      reason: typeof payload.reason === "string" ? payload.reason.trim() : "",
    },
  };
}

/**
 * An app may only propose changes to a note of a type it may read.
 *
 * Checked here, against the note the host actually resolved, rather than
 * against the path the app supplied: otherwise `write: propose` plus one
 * granted type would be write access to the entire vault, which is not what
 * anyone reading that manifest would think they had agreed to.
 */
export function authoriseTarget(type: string, manifest: AppManifest): Authorisation<string> {
  if (!manifest.capabilities.query.includes(type)) {
    return {
      ok: false,
      error: `This app may propose changes only to the note types it may read (${manifest.capabilities.query.join(", ")}). That note is a ${type === "" ? "note with no type" : type}.`,
    };
  }
  return { ok: true, value: type };
}

export interface FieldChange {
  key: string;
  before: unknown;
  after: unknown;
  /** True when the key is not present on the note at all today. */
  added: boolean;
}

/**
 * What a proposal would actually change, for the confirmation dialog.
 *
 * Keys whose value already matches are dropped: a dialog listing twelve fields
 * where only one moves is a dialog nobody reads to the end. If nothing moves,
 * the caller says so rather than writing the note.
 */
export function describeProposal(
  proposal: WriteProposal,
  current: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, after] of Object.entries(proposal.frontmatter)) {
    const before = current[key];
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    changes.push({ key, before, after, added: !(key in current) });
  }
  return changes;
}
