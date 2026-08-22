/**
 * Vault path helpers. Every write in the plugin goes through Obsidian's vault
 * APIs — never `fs`, never outside the vault (rule 8).
 */

import { normalizePath, TFile, TFolder, type App } from "obsidian";

/** Create a folder if it is missing, tolerating a concurrent create. */
export async function ensureFolder(app: App, path: string): Promise<void> {
  const target = normalizePath(path);
  if (target === "" || target === "/") return;

  const existing = app.vault.getAbstractFileByPath(target);
  if (existing instanceof TFolder) return;
  if (existing instanceof TFile) {
    throw new Error(`Cannot create the folder "${target}": a file of that name already exists.`);
  }

  // Parents first; createFolder does not create intermediate folders.
  const parent = target.split("/").slice(0, -1).join("/");
  if (parent !== "") await ensureFolder(app, parent);

  try {
    await app.vault.createFolder(target);
  } catch (error) {
    // Another handler may have created it between the check and the call.
    if (!(app.vault.getAbstractFileByPath(target) instanceof TFolder)) throw error;
  }
}

/** Read a file's text, or null when it does not exist. */
export async function readIfExists(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  return file instanceof TFile ? app.vault.read(file) : null;
}

/**
 * Append text to a file, creating it (and its folder) with `initial` when it
 * does not exist yet. Returns the file.
 */
export async function appendToFile(
  app: App,
  path: string,
  text: string,
  initial = "",
): Promise<TFile> {
  const target = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(target);

  if (existing instanceof TFile) {
    await app.vault.process(existing, (current) =>
      current.endsWith("\n") || current === "" ? current + text : `${current}\n${text}`,
    );
    return existing;
  }
  if (existing !== null) {
    throw new Error(`Cannot write "${target}": it is a folder.`);
  }

  await ensureFolder(app, target.split("/").slice(0, -1).join("/"));
  return app.vault.create(target, initial + text);
}

/** Files directly inside `folder`, newest path order not guaranteed. */
export function filesIn(app: App, folder: string): TFile[] {
  const prefix = `${normalizePath(folder)}/`;
  return app.vault.getFiles().filter((file) => file.path.startsWith(prefix));
}
