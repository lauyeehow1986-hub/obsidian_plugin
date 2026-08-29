/**
 * The apps board's model (§5.13, §7 F3).
 *
 * One assessment per app note: what it is, what it asks for, whether that
 * matches what you agreed to, and whether it could run at all. Ordered worst
 * first, because the two states that need a decision from you — an app that
 * has never been consented to, and one whose manifest has widened since — are
 * the ones a list sorted by title would bury.
 *
 * Pure module: no Obsidian, no Node.
 */

import { checkGrant, type AppGrant, type GrantCheck } from "./grant";
import { describeCapabilities, type AppManifest } from "./manifest";

/**
 * Worst first.
 *
 * `changed` outranks `consent` deliberately: a new app you chose to write is
 * expected to ask; an app you already trusted now asking for more is the case
 * §5.13 built the hash for, and it should not sit below three apps you have
 * simply not run yet.
 */
export const APP_STATES = ["broken", "changed", "consent", "ready"] as const;
export type AppState = (typeof APP_STATES)[number];

export const STATE_LABELS: Record<AppState, string> = {
  broken: "Cannot run",
  changed: "Asks for more than you allowed",
  consent: "Not yet allowed to run",
  ready: "Ready",
};

export interface AppAssessment {
  manifest: AppManifest;
  grant: AppGrant | undefined;
  check: GrantCheck;
  state: AppState;
  /** One line for the board: what it may reach. */
  capabilities: string;
  /** True when running it needs a consent dialog first. */
  needsConsent: boolean;
}

/** Problems that stop an app running at all, as opposed to things worth saying. */
function isFatal(problem: string): boolean {
  return problem.includes("nothing to run");
}

export function assessApp(
  manifest: AppManifest,
  grants: Readonly<Record<string, AppGrant>>,
): AppAssessment {
  const grant = grants[manifest.id];
  const check = checkGrant(manifest.capabilities, grant);
  const broken = manifest.problems.some(isFatal);

  const state: AppState = broken
    ? "broken"
    : check.verdict === "widened"
      ? "changed"
      : check.verdict === "new"
        ? "consent"
        : "ready";

  return {
    manifest,
    grant,
    check,
    state,
    capabilities: describeCapabilities(manifest.capabilities),
    needsConsent: !check.runnable,
  };
}

export interface AppsSummary {
  total: number;
  ready: number;
  awaiting: number;
  broken: number;
}

export function buildRegister(
  manifests: readonly AppManifest[],
  grants: Readonly<Record<string, AppGrant>>,
): AppAssessment[] {
  const assessed = manifests.map((manifest) => assessApp(manifest, grants));
  return assessed.sort((a, b) => {
    const byState = APP_STATES.indexOf(a.state) - APP_STATES.indexOf(b.state);
    if (byState !== 0) return byState;
    return a.manifest.title.localeCompare(b.manifest.title);
  });
}

export function summarise(assessments: readonly AppAssessment[]): AppsSummary {
  return {
    total: assessments.length,
    ready: assessments.filter((entry) => entry.state === "ready").length,
    awaiting: assessments.filter((entry) => entry.state === "consent" || entry.state === "changed")
      .length,
    broken: assessments.filter((entry) => entry.state === "broken").length,
  };
}

export function searchApps(
  assessments: readonly AppAssessment[],
  text: string,
): AppAssessment[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [...assessments];
  return assessments.filter((entry) => {
    const haystack = [
      entry.manifest.id,
      entry.manifest.title,
      entry.manifest.description,
      ...entry.manifest.capabilities.query,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
