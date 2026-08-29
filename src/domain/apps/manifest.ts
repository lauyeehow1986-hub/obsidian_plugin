/**
 * The vault-app manifest (§5.13, §7 F3).
 *
 * A mini-app is a note: frontmatter declaring what it may reach, and a fenced
 * `js` block holding what it does. This module reads that note into a plain
 * object and says what is wrong with it. It runs nothing and it grants nothing
 * — `grant.ts` decides whether a manifest may be trusted, and `broker.ts`
 * enforces it at each request.
 *
 * **The manifest is the whole security model, so it is parsed defensively.**
 * It lives in a note, which means it can be edited by anyone who can edit the
 * vault: by you, by an update, or by whoever sent you the app. Two rules
 * follow, and both are here rather than in the host:
 *
 *  1. **Anything unreadable narrows.** A `query:` that is not a list of
 *     strings grants nothing; a `write:` that is not one of the two words
 *     means `none`. A parse failure must never widen what an app can reach,
 *     which is the one direction a lenient parser tends to fail in.
 *  2. **`network: true` is refused, not honoured.** Rule 3 says outbound
 *     traffic goes through one gateway that is off unless a specific module
 *     is enabled, and no app is that module. A manifest asking for the
 *     network parses, reports a finding, and gets `false`.
 *
 * Pure module: no Obsidian, no Node.
 */

import { findFence, replaceFence } from "../markdown/fence";

export const VAULT_APP_TYPE = "vault-app";

/** The fence an app's JavaScript lives in: ```` ```js app ````. */
export const APP_FENCE = { languages: ["js", "javascript"] as const, tag: "app" };

/**
 * What an app may do with what it reads.
 *
 * `none` — read only. `propose` — it may *offer* a write, which the host shows
 * you in full and you confirm. There is deliberately no third value: an app
 * that could write unattended would make the manifest decorative, and §5.13
 * turns an app's output into a proposal for the same reason rule 5 does it for
 * a model's.
 */
export const WRITE_MODES = ["none", "propose"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const EXPORT_MODES = ["allowed", "denied"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

export interface AppCapabilities {
  /** Note types the app may read, through the broker. Empty means none. */
  query: string[];
  write: WriteMode;
  /** Always false. Kept in the model so a manifest asking for it can be reported. */
  network: false;
}

export interface AppManifest {
  path: string;
  id: string;
  title: string;
  description: string;
  capabilities: AppCapabilities;
  export: ExportMode;
  /** The JavaScript, unmodified. Empty when the note has no `js` fence. */
  source: string;
  /** True when the fence carried the `app` tag rather than being a bare js block. */
  tagged: boolean;
  updated: string;
  /** Everything wrong with the note, in plain English. */
  problems: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the `capabilities:` block.
 *
 * Every failure path here lands on the narrow side. The `problems` it returns
 * are shown beside the app on the board and inside the consent dialog, so a
 * manifest that does not say what it meant is visible rather than quietly
 * reinterpreted.
 */
export function parseCapabilities(
  raw: unknown,
  problems: string[],
): AppCapabilities {
  const capabilities: AppCapabilities = { query: [], write: "none", network: false };
  if (raw === undefined || raw === null) {
    problems.push("No `capabilities:` block — this app can read nothing until it declares what it needs.");
    return capabilities;
  }
  if (!isRecord(raw)) {
    problems.push("`capabilities:` is not a block of settings, so nothing is granted.");
    return capabilities;
  }

  const query = raw.query;
  if (Array.isArray(query)) {
    const types: string[] = [];
    for (const entry of query) {
      const type = str(entry);
      if (type === "") {
        problems.push("`capabilities.query` contains an entry that is not a note type name; it was ignored.");
        continue;
      }
      if (!types.includes(type)) types.push(type);
    }
    capabilities.query = types;
  } else if (typeof query === "string") {
    // One type written without a list is the obvious hand-authored spelling.
    capabilities.query = [query.trim()].filter((type) => type !== "");
  } else if (query !== undefined) {
    problems.push("`capabilities.query` is not a list of note types, so this app may read nothing.");
  }

  const write = str(raw.write);
  if (write !== "" && !(WRITE_MODES as readonly string[]).includes(write)) {
    problems.push(`\`capabilities.write: ${write}\` is not one of ${WRITE_MODES.join(" or ")}; read as "none".`);
  } else if (write !== "") {
    capabilities.write = write as WriteMode;
  }

  // Rule 3. Parsed so it can be *reported*, never honoured: there is no code
  // path in the broker that reaches a network, and an app that asks for one is
  // asking for something this plugin does not have.
  if (raw.network === true || str(raw.network).toLowerCase() === "true") {
    problems.push(
      "This app asks for network access. Vault apps never get it — the sandbox blocks outbound requests and the broker has no way to make one. It will run without it.",
    );
  }

  return capabilities;
}

export interface ManifestInput {
  path: string;
  frontmatter: Record<string, unknown>;
  /** The note body, for the `js` fence. */
  body: string;
}

export function parseManifest(input: ManifestInput): AppManifest {
  const problems: string[] = [];
  const frontmatter = input.frontmatter;

  const id = str(frontmatter.id) || basename(input.path);
  const title = str(frontmatter.title) || id;
  if (str(frontmatter.id) === "") {
    problems.push("No `id:` — the file name is being used instead, so renaming the note loses this app's consent.");
  }

  const capabilities = parseCapabilities(frontmatter.capabilities, problems);

  const exportRaw = str(frontmatter.export);
  let exportMode: ExportMode = "allowed";
  if (exportRaw !== "" && !(EXPORT_MODES as readonly string[]).includes(exportRaw)) {
    problems.push(`\`export: ${exportRaw}\` is not ${EXPORT_MODES.join(" or ")}; read as "allowed".`);
  } else if (exportRaw !== "") {
    exportMode = exportRaw as ExportMode;
  }

  const fence = findFence(input.body, APP_FENCE);
  if (fence === null) {
    problems.push("No ```js app``` block — there is nothing to run.");
  } else if (fence.body.trim() === "") {
    problems.push("The ```js app``` block is empty — there is nothing to run.");
  }

  return {
    path: input.path,
    id,
    title,
    description: str(frontmatter.description),
    capabilities,
    export: exportMode,
    source: fence?.body ?? "",
    tagged: fence?.tagged ?? false,
    updated: str(frontmatter.updated),
    problems,
  };
}

/** Write the app's source back into the note body, touching nothing else. */
export function replaceSource(body: string, source: string): string {
  return replaceFence(body, source, APP_FENCE, "js");
}

/** A one-line summary of what an app may reach, for a board row and a dialog. */
export function describeCapabilities(capabilities: AppCapabilities): string {
  const parts: string[] = [];
  parts.push(
    capabilities.query.length === 0
      ? "reads nothing"
      : `reads ${capabilities.query.join(", ")}`,
  );
  parts.push(capabilities.write === "propose" ? "may propose writes" : "cannot write");
  parts.push("no network");
  return parts.join(" · ");
}

function basename(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}
