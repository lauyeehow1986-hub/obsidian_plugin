import { describe, expect, it } from "vitest";
import {
  migrateSettings,
  settingsReadState,
  unreadableSettingsMessage,
} from "./migrate.js";
import { CURRENT_SETTINGS_VERSION, DEFAULT_FOLDERS, defaultSettings } from "./schema.js";

describe("migrateSettings", () => {
  describe("when there is nothing stored", () => {
    it.each([[null], [undefined], ["a string"], [42], [["an", "array"]]])(
      "initialises defaults from %s",
      (raw) => {
        const result = migrateSettings(raw);
        expect(result.settings).toEqual(defaultSettings());
        expect(result.changed).toBe(true);
        expect(result.fromFuture).toBe(false);
      },
    );
  });

  it("leaves already-current settings untouched", () => {
    const stored = defaultSettings();
    const result = migrateSettings(structuredClone(stored));
    expect(result.settings).toEqual(stored);
    expect(result.changed).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it("preserves keys it does not recognise", () => {
    // Rule 8: never destroy data you did not write. A newer build may own this.
    const stored = { ...defaultSettings(), experimentalThing: { nested: true } };
    const result = migrateSettings(stored);
    expect(result.settings.experimentalThing).toEqual({ nested: true });
  });

  it("keeps customised folder paths while filling in missing ones", () => {
    const result = migrateSettings({
      schemaVersion: CURRENT_SETTINGS_VERSION,
      folders: { requests: "01 Data Requests" },
    });
    expect(result.settings.folders.requests).toBe("01 Data Requests");
    expect(result.settings.folders.audit).toBe(DEFAULT_FOLDERS.audit);
    expect(result.changed).toBe(true);
    expect(result.notes.join(" ")).toMatch(/Filled default paths/);
  });

  it("treats settings with no schemaVersion as pre-v1 and stamps the current version", () => {
    const result = migrateSettings({ mode: "biostat", actor: "yh" });
    expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(result.settings.mode).toBe("biostat");
    expect(result.settings.actor).toBe("yh");
    expect(result.notes.join(" ")).toMatch(/no schema version/i);
  });

  describe("repairing hand-edited data.json", () => {
    it("resets an unknown mode and says so", () => {
      const result = migrateSettings({ schemaVersion: 1, mode: "wizard" });
      expect(result.settings.mode).toBe(defaultSettings().mode);
      expect(result.notes.join(" ")).toMatch(/Unknown mode/);
    });

    it("resets a non-string actor", () => {
      const result = migrateSettings({ schemaVersion: 1, actor: { name: "yh" } });
      expect(result.settings.actor).toBe("");
    });

    it("resets an unknown hat filter", () => {
      const result = migrateSettings({ schemaVersion: 2, hatFilter: "sometimes" });
      expect(result.settings.hatFilter).toBe("mode");
    });

    it("resets an unknown bases setting", () => {
      const result = migrateSettings({ schemaVersion: 1, bases: "always" });
      expect(result.settings.bases).toBe("auto");
    });

    it("replaces a blank folder path rather than writing notes to the vault root", () => {
      const result = migrateSettings({ schemaVersion: 1, folders: { requests: "   " } });
      expect(result.settings.folders.requests).toBe(DEFAULT_FOLDERS.requests);
    });

    it("survives folders being the wrong type entirely", () => {
      const result = migrateSettings({ schemaVersion: 1, folders: "nope" });
      expect(result.settings.folders).toEqual(DEFAULT_FOLDERS);
    });
  });

  describe("v1 → v2, which added the hat filter", () => {
    it("supplies the default without touching anything else", () => {
      const v1 = { schemaVersion: 1, actor: "yh", mode: "biostat", bases: "off" };
      const result = migrateSettings(v1);
      expect(result.settings.hatFilter).toBe("mode");
      expect(result.settings.actor).toBe("yh");
      expect(result.settings.mode).toBe("biostat");
      expect(result.settings.bases).toBe("off");
      expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_VERSION);
    });

    it("leaves a trail, because an upgrade with no console needs one", () => {
      const notes = migrateSettings({ schemaVersion: 1 }).notes.join(" ");
      expect(notes).toContain("v1");
      expect(notes).toContain("v2");
    });

    it("does not claim a v1 → v2 step for settings that were never v1", () => {
      const notes = migrateSettings({ schemaVersion: 2, hatFilter: "all" }).notes.join(" ");
      expect(notes).not.toContain("v1 → v2");
    });
  });

  describe("settings written by a newer build", () => {
    const future = {
      schemaVersion: CURRENT_SETTINGS_VERSION + 5,
      mode: "some-future-mode",
      featureFromTheFuture: true,
    };

    it("does not rewrite them", () => {
      const result = migrateSettings(structuredClone(future));
      expect(result.settings).toEqual(future);
      expect(result.changed).toBe(false);
    });

    it("flags the situation so diagnostics can report it", () => {
      const result = migrateSettings(structuredClone(future));
      expect(result.fromFuture).toBe(true);
      expect(result.notes.join(" ")).toMatch(/newer version/i);
    });

    it("does not 'repair' a mode it simply does not know about yet", () => {
      const result = migrateSettings(structuredClone(future));
      expect(result.settings.mode).toBe("some-future-mode");
    });
  });

  describe("backup settings (v3)", () => {
    it("adds them to a v2 vault without touching anything else", () => {
      const result = migrateSettings({ schemaVersion: 2, actor: "yh", hatFilter: "all" });
      expect(result.settings.backup).toEqual({
        destination: "",
        keep: 7,
        intervalDays: 7,
        lastAt: "",
        lastName: "",
      });
      expect(result.settings.actor).toBe("yh");
      expect(result.settings.hatFilter).toBe("all");
      expect(result.notes.join(" ")).toMatch(/no destination is set/i);
    });

    it("keeps a destination the user typed, whatever else is wrong with the block", () => {
      // Replacing the whole block because one number is bad would silently
      // forget a path set once months ago.
      const result = migrateSettings({
        schemaVersion: 3,
        backup: { destination: "D:/snapshots", keep: "lots", intervalDays: 0 },
      });
      expect(result.settings.backup.destination).toBe("D:/snapshots");
      expect(result.settings.backup.keep).toBe(7);
      expect(result.settings.backup.intervalDays).toBe(1);
    });

    it("clamps rather than resets, so a small number stays small", () => {
      const result = migrateSettings({ schemaVersion: 3, backup: { keep: 2 } });
      expect(result.settings.backup.keep).toBe(2);
      expect(result.settings.backup.destination).toBe("");
    });

    it("never invents a destination", () => {
      // Guessing a folder would mean writing the whole vault somewhere nobody
      // chose. The commands refuse until it is set.
      expect(migrateSettings(null).settings.backup.destination).toBe("");
      expect(migrateSettings({ schemaVersion: 3, backup: 42 }).settings.backup.destination).toBe("");
    });
  });

  describe("an empty read", () => {
    it("is flagged so the caller does not persist over it", () => {
      // A first install and a failed read are indistinguishable from here.
      // Writing defaults would destroy a configured backup destination in the
      // second case and gain nothing in the first.
      for (const empty of [null, undefined, "", 0, []]) {
        expect(migrateSettings(empty).fromNothing).toBe(true);
      }
    });

    it("is not flagged when something was actually read", () => {
      expect(migrateSettings({ schemaVersion: 3 }).fromNothing).toBe(false);
      expect(migrateSettings({}).fromNothing).toBe(false);
      expect(migrateSettings({ schemaVersion: 99 }).fromNothing).toBe(false);
    });
  });

  describe("telling a first install from a broken file", () => {
    it("is a first install when nothing was read and no file is there", () => {
      expect(settingsReadState(true, false)).toBe("first-install");
    });

    it("is unreadable when nothing was read but a file exists", () => {
      // The case that matters: loadData() returns null for a data.json it
      // could not parse exactly as it does for one that is not there.
      expect(settingsReadState(true, true)).toBe("unreadable");
    });

    it("is loaded whenever something was read, file check notwithstanding", () => {
      expect(settingsReadState(false, true)).toBe("loaded");
      expect(settingsReadState(false, false)).toBe("loaded");
    });

    it("says what happened, what was not damaged, and what to do", () => {
      const message = unreadableSettingsMessage(".obsidian/plugins/scdb-cockpit/data.json");
      expect(message).toContain(".obsidian/plugins/scdb-cockpit/data.json");
      expect(message).toContain("running on defaults");
      expect(message).toMatch(/nothing has been overwritten/i);
      expect(message).toMatch(/repair or delete/i);
    });
  });
});
