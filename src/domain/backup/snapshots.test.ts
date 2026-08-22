import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { backupAge, formatBytes, parseSnapshotName, planRetention, snapshotName } from "./snapshots";

// Local noon, so a date-only comparison cannot slide across a day boundary.
const NOW = new Date(2026, 7, 22, 12, 0, 0).getTime();

describe("snapshot names", () => {
  it("round-trips a name back to the second it was taken", () => {
    const at = new Date(2026, 7, 22, 14, 3, 17).getTime();
    const name = snapshotName(at);
    expect(name).toBe("scdb-vault-2026-08-22-140317.scdbak");
    expect(parseSnapshotName(name)).toBe(at);
  });

  it("gives two snapshots in the same minute different names", () => {
    // Minute resolution would put them on one name, and the writer refuses to
    // overwrite — so the second backup of the day would simply fail.
    const a = snapshotName(new Date(2026, 7, 22, 14, 3, 5).getTime());
    const b = snapshotName(new Date(2026, 7, 22, 14, 3, 40).getTime());
    expect(a).not.toBe(b);
  });

  it("sorts chronologically as plain text", () => {
    // The destination is browsed in Explorer as often as in the plugin, so the
    // name has to order correctly with no help from a file date.
    const names = [
      snapshotName(new Date(2026, 8, 1, 9, 0, 0).getTime()),
      snapshotName(new Date(2026, 7, 22, 14, 3, 0).getTime()),
      snapshotName(new Date(2026, 7, 22, 9, 30, 0).getTime()),
    ];
    expect([...names].sort()).toEqual([names[2], names[1], names[0]]);
  });

  it("recognises nothing but its own pattern", () => {
    for (const name of [
      "invoice.pdf",
      "scdb-vault.scdbak",
      "scdb-vault-2026-08-22.scdbak",
      // The old minute-resolution name. Unrecognised is the safe answer: it
      // becomes a foreign file the retention sweep will never delete.
      "scdb-vault-2026-08-22-1403.scdbak",
      "scdb-vault-2026-08-22-140317.zip",
      "vault-2026-08-22-140317.scdbak",
      "scdb-vault-2026-08-22-140317.scdbak.part",
    ]) {
      expect(parseSnapshotName(name)).toBeNull();
    }
  });
});

describe("planRetention", () => {
  const a = "scdb-vault-2026-08-20-090000.scdbak";
  const b = "scdb-vault-2026-08-21-090000.scdbak";
  const c = "scdb-vault-2026-08-22-090000.scdbak";

  it("keeps the newest and marks the rest for removal", () => {
    const plan = planRetention([a, c, b], 2);
    expect(plan.keep).toEqual([c, b]);
    expect(plan.remove).toEqual([a]);
  });

  it("never lists a file it did not name as removable", () => {
    // The destination is an ordinary folder — on Windows very likely Downloads.
    // A sweep that could reach anything else would be a catastrophe.
    const plan = planRetention(["tax-return.pdf", "setup.exe", a, b, c], 1);
    expect(plan.remove).toEqual([b, a]);
    expect(plan.foreign.sort()).toEqual(["setup.exe", "tax-return.pdf"]);
  });

  it("always keeps at least one, however the limit was mangled", () => {
    for (const keep of [0, -3, 0.4]) {
      const plan = planRetention([a, b, c], keep);
      expect(plan.keep).toEqual([c]);
      expect(plan.remove).toEqual([b, a]);
    }
  });

  it("removes nothing when there are fewer snapshots than the limit", () => {
    expect(planRetention([a, b], 7).remove).toEqual([]);
  });

  it("counts the snapshot about to be written", () => {
    // The sweep runs after the new file lands, so the confirmation has to plan
    // against the folder as it will be then. Planning against the folder as it
    // is now under-reports by one — a dialog that mentions no deletions and
    // then deletes a backup.
    const pending = "scdb-vault-2026-08-23-090000.scdbak";
    expect(planRetention([a, b, c], 2).remove).toEqual([a]);
    expect(planRetention([a, b, c, pending], 2).remove).toEqual([b, a]);
  });
});

describe("backupAge", () => {
  it("treats never having backed up as stale, not as neutral", () => {
    // A vault that has never been snapshotted is the exact situation A4 exists
    // for; a missing value reading as "no news" is how it stays that way.
    const age = backupAge(null, 7, NOW);
    expect(age.stale).toBe(true);
    expect(age.days).toBeNull();
    expect(age.text).toMatch(/has ever been taken/i);
  });

  it("goes stale on the interval, not after it", () => {
    expect(backupAge(NOW - 6 * DAY_MS, 7, NOW).stale).toBe(false);
    expect(backupAge(NOW - 7 * DAY_MS, 7, NOW).stale).toBe(true);
  });

  it("says the age in words a person would use", () => {
    expect(backupAge(NOW, 7, NOW).text).toContain("today");
    expect(backupAge(NOW - DAY_MS, 7, NOW).text).toContain("yesterday");
    expect(backupAge(NOW - 3 * DAY_MS, 7, NOW).text).toContain("3 days ago");
  });

  it("does not report a negative age from a clock that has moved back", () => {
    expect(backupAge(NOW + 2 * DAY_MS, 7, NOW).days).toBe(0);
  });
});

describe("formatBytes", () => {
  it("scales and keeps one decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
