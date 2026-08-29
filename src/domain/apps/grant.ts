/**
 * Consent to run a vault app, and noticing when what it asks for changes
 * (§5.13, §7 F3).
 *
 * §5.13 is explicit about the failure this exists to prevent: *"an app trusted
 * at `write: none` can be edited later to request more — by you, by an update,
 * or by whoever sent it to you."* The manifest lives in a note, so consent
 * cannot be a one-off tick. It is recorded against a **hash of what was
 * granted**, and every run compares.
 *
 * Three outcomes, and the asymmetry between them is the point:
 *
 *  - **`unchanged`** — run.
 *  - **`narrowed`** — run. The app now asks for less than you already allowed,
 *    and stopping to ask about that would train you to click through the
 *    dialog that matters.
 *  - **`widened`** — ask again, *naming exactly what changed*. A dialog that
 *    said only "capabilities have changed" would be answered the same way
 *    every time; one that says "it now also wants to read correspondence"
 *    can actually be refused.
 *
 * The hash covers the capabilities only, not the source. That is deliberate
 * and it is the line §5.13 draws: re-prompting on every edit to the code would
 * make the prompt meaningless within a day of working on an app, while the
 * capabilities are the only thing that decides what the code can *reach*. The
 * sandbox is what makes that a safe trade — code the broker will not answer
 * cannot do anything with an extra line.
 *
 * Pure module: no Obsidian, no Node.
 */

import { sha256 } from "../audit/sha256";
import type { AppCapabilities } from "./manifest";

/** How many hex digits of the digest are stored. Enough to be unambiguous. */
const GRANT_DIGITS = 16;

/** What the user agreed to, as it is stored in settings. */
export interface AppGrant {
  /** Digest of the capabilities that were granted. */
  hash: string;
  /** `YYYY-MM-DD` the grant was given, for the settings tab and diagnostics. */
  at: string;
  /** The granted capabilities in full, so a change can be *described*, not just detected. */
  capabilities: AppCapabilities;
}

export type GrantVerdict = "new" | "unchanged" | "widened" | "narrowed";

export interface GrantCheck {
  verdict: GrantVerdict;
  /** True when the app may run without asking again. */
  runnable: boolean;
  /** What changed since the grant, in plain English. Empty when nothing did. */
  changes: string[];
}

/**
 * The digest of a set of capabilities.
 *
 * Canonicalised first — query types sorted, everything spelled the same way
 * every time — so re-ordering the list in the note is not mistaken for asking
 * for something new. A prompt raised by a cosmetic edit is a prompt that gets
 * clicked through.
 */
export function grantHash(capabilities: AppCapabilities): string {
  const canonical = JSON.stringify({
    query: [...capabilities.query].sort(),
    write: capabilities.write,
    network: false,
  });
  return sha256(canonical).slice(0, GRANT_DIGITS);
}

export function newGrant(capabilities: AppCapabilities, at: string): AppGrant {
  return {
    hash: grantHash(capabilities),
    at,
    capabilities: { query: [...capabilities.query], write: capabilities.write, network: false },
  };
}

/**
 * Compare what an app now asks for against what it was granted.
 *
 * A missing or malformed stored grant reads as `new` rather than as a pass:
 * settings are a JSON file on disk, and the failure mode of trusting a
 * half-written one is running an app nobody consented to.
 */
export function checkGrant(
  capabilities: AppCapabilities,
  grant: AppGrant | undefined,
): GrantCheck {
  if (grant === undefined || typeof grant.hash !== "string" || grant.hash === "") {
    return { verdict: "new", runnable: false, changes: [] };
  }

  if (grant.hash === grantHash(capabilities)) {
    return { verdict: "unchanged", runnable: true, changes: [] };
  }

  const granted = grant.capabilities ?? { query: [], write: "none", network: false };
  const grantedTypes = new Set(granted.query ?? []);
  const wantedTypes = new Set(capabilities.query);

  const added = [...wantedTypes].filter((type) => !grantedTypes.has(type)).sort();
  const removed = [...grantedTypes].filter((type) => !wantedTypes.has(type)).sort();
  const writeWidened = granted.write !== "propose" && capabilities.write === "propose";
  const writeNarrowed = granted.write === "propose" && capabilities.write !== "propose";

  const changes: string[] = [];
  if (added.length > 0) {
    changes.push(`It now also wants to read: ${added.join(", ")}.`);
  }
  if (writeWidened) {
    changes.push("It now wants to propose changes to notes, which it could not before.");
  }
  if (removed.length > 0) {
    changes.push(`It no longer reads: ${removed.join(", ")}.`);
  }
  if (writeNarrowed) {
    changes.push("It no longer proposes changes to notes.");
  }

  const widened = added.length > 0 || writeWidened;
  return {
    verdict: widened ? "widened" : "narrowed",
    runnable: !widened,
    changes,
  };
}

/** A line for the audit ledger's `detail` cell: counts and names, never content. */
export function describeGrant(capabilities: AppCapabilities): string {
  const types = capabilities.query.length === 0 ? "nothing" : capabilities.query.join(",");
  return `reads ${types}; write ${capabilities.write}; network false`;
}
