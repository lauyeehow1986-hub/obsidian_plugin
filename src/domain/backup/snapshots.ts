/**
 * Snapshot naming, retention and staleness (CLAUDE.md §7 A4).
 *
 * Pure so the one genuinely dangerous decision in the backup feature — which
 * files get deleted — is decided by a tested function rather than by a glob at
 * the call site. Everything here works on names; nothing here touches a disk.
 *
 * Pure module: no Obsidian, no Node.
 */

import { DAY_MS, toVaultDate } from "../time/dates";

export const SNAPSHOT_EXTENSION = "scdbak";
export const SNAPSHOT_PREFIX = "scdb-vault-";

/**
 * `scdb-vault-2026-08-22-140317.scdbak`.
 *
 * Local time, and the name is the timestamp: it has to sort chronologically as
 * plain text in a file listing, and it has to mean something to a person
 * looking at a folder in Explorer six months later.
 *
 * **Seconds, not minutes.** Minute resolution reads better, but two snapshots
 * taken in the same minute would land on one name — and since the writer must
 * never overwrite, the second would either fail or, worse, silently replace a
 * backup taken thirty seconds earlier. Sealing alone takes a fifth of a second,
 * so a second-resolution name cannot realistically collide.
 */
const NAME_RE = /^scdb-vault-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.scdbak$/;

export function snapshotName(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${SNAPSHOT_PREFIX}${toVaultDate(ms)}-${clock}.${SNAPSHOT_EXTENSION}`;
}

/** Epoch ms encoded in a snapshot's name, or null when the name is not ours. */
export function parseSnapshotName(name: string): number | null {
  const match = NAME_RE.exec(name);
  if (match === null) return null;
  const [, date, hours, minutes, seconds] = match;
  const at = new Date(`${date}T${hours}:${minutes}:${seconds}`).getTime();
  return Number.isNaN(at) ? null : at;
}

export interface Retention {
  /** Ours, newest first. */
  keep: string[];
  /** Ours, oldest, beyond the limit. Only these may ever be deleted. */
  remove: string[];
  /** Everything else in the folder. Never touched, and counted so we can say so. */
  foreign: string[];
}

/**
 * Decide which snapshots survive.
 *
 * The `foreign` bucket is the point of this function. The destination is an
 * ordinary folder on the user's machine — on Windows, very likely Downloads —
 * so it is full of files that have nothing to do with us. A retention sweep
 * that deleted "the oldest files in the folder" would be a catastrophe, and
 * "the oldest .scdbak files" is only slightly better. Nothing is deletable
 * unless its name matches the exact pattern this plugin writes.
 */
export function planRetention(names: readonly string[], keep: number): Retention {
  const limit = Math.max(1, Math.floor(keep));
  const mine: { name: string; at: number }[] = [];
  const foreign: string[] = [];

  for (const name of names) {
    const at = parseSnapshotName(name);
    if (at === null) foreign.push(name);
    else mine.push({ name, at });
  }

  mine.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  return {
    keep: mine.slice(0, limit).map((entry) => entry.name),
    remove: mine.slice(limit).map((entry) => entry.name),
    foreign,
  };
}

export interface BackupAge {
  /** Whole days since the last successful snapshot; null when there has never been one. */
  days: number | null;
  /** True when the nag should show. Never having taken one counts as stale. */
  stale: boolean;
  /** One sentence for the status bar tooltip and the diagnostics report. */
  text: string;
}

/**
 * How old the last snapshot is, and whether to say something about it.
 *
 * "Never" is stale rather than neutral. A vault that has never been backed up
 * is the exact situation A4 exists for, and treating a missing value as "no
 * news" is how it stays that way.
 */
export function backupAge(lastAt: number | null, intervalDays: number, now: number): BackupAge {
  if (lastAt === null) {
    return { days: null, stale: true, text: "No snapshot has ever been taken from this vault." };
  }
  const days = Math.max(0, Math.floor((now - lastAt) / DAY_MS));
  const stale = days >= Math.max(1, Math.floor(intervalDays));
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return {
    days,
    stale,
    text: stale
      ? `Last snapshot was ${when}, past the ${intervalDays}-day interval you set.`
      : `Last snapshot was ${when}.`,
  };
}

/** `1.4 MB`. Sizes are reported at one decimal so a growing vault is visible. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
