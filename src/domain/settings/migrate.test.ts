import { describe, expect, it } from "vitest";
import { migrateSettings } from "./migrate.js";
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
});
