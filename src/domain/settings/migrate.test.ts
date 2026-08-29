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

  describe("v3 -> v4: messages and the briefing", () => {
    it("adds the new blocks to a v3 file without touching what was there", () => {
      const result = migrateSettings({
        schemaVersion: 3,
        actor: "yh",
        backup: { destination: "D:\snapshots", keep: 5, intervalDays: 7, lastAt: "", lastName: "" },
      });
      expect(result.settings.comms.uriCeiling).toBe(1800);
      expect(result.settings.comms.chaseDays).toBe(7);
      expect(result.settings.briefing.onOpen).toBe(false);
      expect(result.settings.actor).toBe("yh");
      expect(result.settings.backup.destination).toBe("D:\snapshots");
      expect(result.notes.join(" ")).toContain("v3 -> v4");
    });

    it("leaves the briefing off on a fresh install", () => {
      // Rule 3, applied to the vault: writing a note into someone's vault the
      // first time they open it is a decision that was theirs to make.
      expect(migrateSettings(null).settings.briefing.onOpen).toBe(false);
    });

    it("adds the briefings folder without disturbing customised paths", () => {
      const result = migrateSettings({
        schemaVersion: 3,
        folders: { requests: "Requests", dashboards: "Boards" },
      });
      expect(result.settings.folders.briefings).toBe("90 Dashboards/Briefings");
      expect(result.settings.folders.requests).toBe("Requests");
      expect(result.settings.folders.dashboards).toBe("Boards");
    });

    it("clamps a URI ceiling rather than resetting it, and says so", () => {
      // Too low and nothing composes; too high and a chase-up arrives cut off.
      const low = migrateSettings({ schemaVersion: 4, comms: { uriCeiling: 5 } });
      expect(low.settings.comms.uriCeiling).toBe(200);
      expect(low.notes.join(" ")).toContain("uriCeiling was 5");

      expect(
        migrateSettings({ schemaVersion: 4, comms: { uriCeiling: 99999 } }).settings.comms
          .uriCeiling,
      ).toBe(8000);
    });

    it("resets an unknown channel and keeps the rest of the block", () => {
      const result = migrateSettings({
        schemaVersion: 4,
        comms: { channel: "carrier pigeon", chaseDays: 14 },
      });
      expect(result.settings.comms.channel).toBe("email");
      expect(result.settings.comms.chaseDays).toBe(14);
      expect(result.notes.join(" ")).toContain("carrier pigeon");
    });

    it("keeps lastDate verbatim, because repairing it would regenerate over yesterday", () => {
      const result = migrateSettings({
        schemaVersion: 4,
        briefing: { onOpen: true, lastDate: "2026-08-22", horizonDays: 30 },
      });
      expect(result.settings.briefing.lastDate).toBe("2026-08-22");
      expect(result.settings.briefing.onOpen).toBe(true);
      expect(result.settings.briefing.horizonDays).toBe(30);
    });
  });
  describe("v4 -> v5: the effort timer", () => {
    it("adds the effort block with no timer running", () => {
      const result = migrateSettings({ schemaVersion: 4, actor: "yh" });
      expect(result.settings.effort).toEqual({ idleMinutes: 10, costCentre: "", timer: null });
      expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_VERSION);
      expect(result.notes.join(" ")).toContain("v4 -> v5");
    });

    it("keeps a timer that reads properly", () => {
      const timer = {
        status: "running",
        startedAt: 1,
        segmentFrom: 1,
        banked: 0,
        beat: 2,
        binding: { person: "yh", ref: "REQ-1", activity: "qc", study: "", costCentre: "", note: "" },
      };
      const result = migrateSettings({ schemaVersion: 5, effort: { idleMinutes: 10, costCentre: "", timer } });
      expect(result.settings.effort.timer).toEqual(timer);
    });

    it("discards a timer it cannot read rather than repairing one", () => {
      // A timer is a claim about hours worked. Inventing a plausible one from a
      // half-written data.json would put minutes nobody worked into a log that
      // justifies posts.
      for (const broken of [
        { status: "sprinting", startedAt: 1, segmentFrom: 1, banked: 0, beat: 2, binding: {} },
        { status: "running", startedAt: "nine", segmentFrom: 1, banked: 0, beat: 2, binding: {} },
        { status: "running", startedAt: 1, segmentFrom: 1, banked: 0, beat: 2 },
      ]) {
        const result = migrateSettings({ schemaVersion: 5, effort: { timer: broken } });
        expect(result.settings.effort.timer).toBeNull();
        expect(result.notes.join(" ")).toContain("discarded");
      }
    });

    it("says nothing about a timer that was simply absent", () => {
      const result = migrateSettings({ schemaVersion: 5, effort: { timer: null } });
      expect(result.notes.join(" ")).not.toContain("discarded");
    });

    it("clamps the idle threshold rather than resetting it", () => {
      // Floored at two heartbeats: a one-minute threshold fires on every
      // ordinary beat, so the dialog would appear once a minute forever.
      expect(migrateSettings({ schemaVersion: 5, effort: { idleMinutes: 0 } }).settings.effort.idleMinutes).toBe(2);
      expect(migrateSettings({ schemaVersion: 5, effort: { idleMinutes: 1 } }).settings.effort.idleMinutes).toBe(2);
      expect(
        migrateSettings({ schemaVersion: 5, effort: { idleMinutes: 9999 } }).settings.effort.idleMinutes,
      ).toBe(480);
    });
  });

  describe("v5 -> v6: recurring obligations and the calendar", () => {
    it("adds the events block to a v5 file without touching what was there", () => {
      const result = migrateSettings({
        schemaVersion: 5,
        actor: "yh",
        effort: { idleMinutes: 15, costCentre: "RC-2026-07", timer: null },
      });
      expect(result.settings.events.leadDays).toEqual([30, 7, 1]);
      expect(result.settings.events.calendarFile).toBe("scdb-deadlines.ics");
      expect(result.settings.effort.idleMinutes).toBe(15);
      expect(result.settings.effort.costCentre).toBe("RC-2026-07");
      expect(result.notes.join(" ")).toContain("v5 -> v6");
    });

    it("keeps custom lead times, sorted and deduplicated", () => {
      const result = migrateSettings({ schemaVersion: 6, events: { leadDays: [7, 60, 7] } });
      expect(result.settings.events.leadDays).toEqual([60, 7]);
    });

    it("will not accept an empty list of lead times", () => {
      // No lead time means the first anyone hears of an IRB renewal is the day
      // it lapses. A note can still opt out with `lead_days: []` of its own.
      const result = migrateSettings({ schemaVersion: 6, events: { leadDays: [] } });
      expect(result.settings.events.leadDays).toEqual([30, 7, 1]);
      expect(result.notes.join(" ")).toContain("unusable");
    });

    it("drops nonsense entries but keeps the usable ones", () => {
      const result = migrateSettings({
        schemaVersion: 6,
        events: { leadDays: [30, "soon", -4, 7] },
      });
      expect(result.settings.events.leadDays).toEqual([30, 7]);
    });

    it("clamps the reminder interval rather than resetting it", () => {
      const result = migrateSettings({ schemaVersion: 6, events: { checkMinutes: 1 } });
      expect(result.settings.events.checkMinutes).toBe(5);
      expect(result.notes.join(" ")).toContain("Reminder interval was 1");
    });

    it("leaves the lapsed-obligation notice on unless it was switched off", () => {
      expect(migrateSettings(null).settings.events.notifyOnOpen).toBe(true);
      expect(
        migrateSettings({ schemaVersion: 6, events: { notifyOnOpen: false } }).settings.events
          .notifyOnOpen,
      ).toBe(false);
    });

    it("resets an events block that is not a block at all", () => {
      const result = migrateSettings({ schemaVersion: 6, events: 42 });
      expect(result.settings.events.leadDays).toEqual([30, 7, 1]);
      expect(result.notes.join(" ")).toContain("Event settings were not readable");
    });
  });

  describe("v6 -> v7: importing saved email files", () => {
    it("starts with no addresses, so the importer refuses until told who you are", () => {
      // Not a shy default. Direction is what `awaiting` is computed from, and
      // guessing it backwards turns an unanswered chase-up into a closed loop.
      expect(migrateSettings(null).settings.comms.myAddresses).toEqual([]);
    });

    it("keeps a v6 file's message settings while adding the new ones", () => {
      const result = migrateSettings({
        schemaVersion: 6,
        comms: { uriCeiling: 1400, chaseDays: 10, channel: "teams" },
      });
      expect(result.settings.comms.uriCeiling).toBe(1400);
      expect(result.settings.comms.channel).toBe("teams");
      expect(result.settings.comms.emlAttachments).toBe("attachments");
      expect(result.notes.join(" ")).toContain("Migrated v6 -> v7");
    });

    it("lower-cases and deduplicates the addresses", () => {
      const result = migrateSettings({
        schemaVersion: 7,
        comms: { myAddresses: ["YH@Example.org", " yh@example.org "] },
      });
      expect(result.settings.comms.myAddresses).toEqual(["yh@example.org"]);
    });

    it("drops an entry that is not an address, and says so", () => {
      const result = migrateSettings({
        schemaVersion: 7,
        comms: { myAddresses: ["yh@example.org", "just my name", "a@b.org, c@d.org"] },
      });
      expect(result.settings.comms.myAddresses).toEqual(["yh@example.org"]);
      expect(result.notes.join(" ")).toContain("were not addresses");
    });

    it("resets an unknown attachment policy rather than honouring it", () => {
      const result = migrateSettings({
        schemaVersion: 7,
        comms: { emlAttachments: "everything" },
      });
      expect(result.settings.comms.emlAttachments).toBe("attachments");
      expect(result.notes.join(" ")).toContain("Unknown attachment setting");
    });

    it("clamps an unusable attachment size limit", () => {
      const result = migrateSettings({ schemaVersion: 7, comms: { emlMaxAttachmentKb: 0 } });
      expect(result.settings.comms.emlMaxAttachmentKb).toBe(1);
    });
  });

  describe("v7 -> v8: the publications tracker", () => {
    it("defaults to Vancouver, as §5.4 names it", () => {
      expect(migrateSettings(null).settings.publications.citationFormat).toBe("vancouver");
    });

    it("adds the block to a v7 file without disturbing anything else", () => {
      const result = migrateSettings({
        schemaVersion: 7,
        actor: "yh",
        comms: { uriCeiling: 1400 },
      });
      expect(result.settings.publications.citationFormat).toBe("vancouver");
      expect(result.settings.actor).toBe("yh");
      expect(result.settings.comms.uriCeiling).toBe(1400);
      expect(result.notes.join(" ")).toContain("Migrated v7 -> v8");
    });

    it("keeps a format the user chose", () => {
      const result = migrateSettings({
        schemaVersion: 8,
        publications: { citationFormat: "apa" },
      });
      expect(result.settings.publications.citationFormat).toBe("apa");
    });

    it("resets a format the formatter does not know, and says so", () => {
      // `schema.ts` keeps its own copy of the format names so it does not have
      // to import the publication engine; this is the seam that holds the two
      // together, and an unknown name reaching the formatter produces nothing.
      const result = migrateSettings({
        schemaVersion: 8,
        publications: { citationFormat: "harvard" },
      });
      expect(result.settings.publications.citationFormat).toBe("vancouver");
      expect(result.notes.join(" ")).toContain("Unknown citation format");
    });

    it("survives a publications block that is not a mapping", () => {
      const result = migrateSettings({ schemaVersion: 8, publications: 42 });
      expect(result.settings.publications.citationFormat).toBe("vancouver");
      expect(result.notes.join(" ")).toContain("Publication settings were not readable");
    });
  });


  describe("running code (§7 F1)", () => {
    it("configures no interpreter on upgrade from v9", () => {
      const result = migrateSettings({ schemaVersion: 9 });
      expect(result.settings.compute.rPath).toBe("");
      expect(result.settings.compute.pythonPath).toBe("");
      expect(result.notes.join(" ")).toContain("Neither");
    });

    it("keeps paths that were set", () => {
      const result = migrateSettings({
        schemaVersion: 10,
        compute: {
          rPath: "C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe",
          pythonPath: "C:\\Python314\\python.exe",
        },
      });
      expect(result.settings.compute.rPath).toBe("C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe");
      expect(result.settings.compute.pythonPath).toBe("C:\\Python314\\python.exe");
    });

    // An unreadable value falls back to "not configured", not to a guess. The
    // failure that produces is a dialog; the failure a guess produces is a run
    // against an interpreter nobody chose, recorded as though they had.
    it("falls back to not configured when the block is unreadable", () => {
      const result = migrateSettings({ schemaVersion: 10, compute: "yes please" });
      expect(result.settings.compute.pythonPath).toBe("");
      expect(result.notes.join(" ")).toContain("no interpreter is configured");
    });

    it("keeps the hardened isolation when the stored value is not one we know", () => {
      const result = migrateSettings({ schemaVersion: 10, compute: { pythonIsolation: "off" } });
      expect(result.settings.compute.pythonIsolation).toBe("isolated");
      expect(result.notes.join(" ")).toContain("using the isolated default");
    });

    it("keeps a relaxed isolation that was deliberately chosen", () => {
      const result = migrateSettings({ schemaVersion: 10, compute: { pythonIsolation: "user-site" } });
      expect(result.settings.compute.pythonIsolation).toBe("user-site");
    });

    // A person who typed 5000 meant "a long time". Zero and negative are the
    // ones that matter, and they cannot survive the clamp.
    it("clamps a timeout and an output cap rather than refusing them", () => {
      const result = migrateSettings({
        schemaVersion: 10,
        compute: { timeoutSeconds: 100000, maxOutputKb: 0 },
      });
      expect(result.settings.compute.timeoutSeconds).toBe(3600);
      expect(result.settings.compute.maxOutputKb).toBe(1);
    });

    it("never lets a timeout reach zero", () => {
      const result = migrateSettings({ schemaVersion: 10, compute: { timeoutSeconds: -5 } });
      expect(result.settings.compute.timeoutSeconds).toBe(5);
    });
  });

  describe("vault apps (§5.13, §7 F3)", () => {
    it("grants nothing on upgrade from v8", () => {
      const result = migrateSettings({ schemaVersion: 8 });
      expect(result.settings.apps.grants).toEqual({});
      expect(result.notes.join(" ")).toContain("No app is allowed to run until you say so");
    });

    it("keeps a grant that was given", () => {
      const result = migrateSettings({
        schemaVersion: 9,
        apps: {
          grants: {
            "APP-x": {
              hash: "abc123",
              at: "2026-08-29",
              capabilities: { query: ["run"], write: "propose", network: false },
            },
          },
        },
      });
      expect(result.settings.apps.grants["APP-x"]?.hash).toBe("abc123");
      expect(result.settings.apps.grants["APP-x"]?.capabilities.write).toBe("propose");
    });

    /**
     * Every failure path here has to land on "granted nothing". Getting it
     * wrong this way costs one dialog; getting it wrong the other way runs
     * someone's code against the vault with nobody's consent.
     */
    it("drops a grant with no hash, and says those apps will ask again", () => {
      const result = migrateSettings({
        schemaVersion: 9,
        apps: { grants: { "APP-x": { at: "2026-08-29" }, "APP-y": "yes" } },
      });
      expect(result.settings.apps.grants).toEqual({});
      expect(result.notes.join(" ")).toContain("will ask again");
    });

    it("grants nothing when the block is not a mapping", () => {
      const result = migrateSettings({ schemaVersion: 9, apps: "trust everything" });
      expect(result.settings.apps.grants).toEqual({});
      expect(result.notes.join(" ")).toContain("no app is granted");
    });

    it("never restores network access to a stored grant", () => {
      const result = migrateSettings({
        schemaVersion: 9,
        apps: {
          grants: {
            "APP-x": { hash: "h", at: "", capabilities: { query: [], write: "none", network: true } },
          },
        },
      });
      expect(result.settings.apps.grants["APP-x"]?.capabilities.network).toBe(false);
    });

    it("clamps a watchdog nobody could wait for", () => {
      expect(migrateSettings({ schemaVersion: 9, apps: { watchdogSeconds: 0 } }).settings.apps.watchdogSeconds).toBe(2);
      expect(migrateSettings({ schemaVersion: 9, apps: { watchdogSeconds: 9000 } }).settings.apps.watchdogSeconds).toBe(120);
    });
  });

  describe("v10 -> v11: external sources (§7 E1)", () => {
    it("leaves every source off on an upgrade from v10", () => {
      // Rule 3: nothing is enabled on first install, and an upgrade is a first
      // install of this feature.
      const result = migrateSettings({ schemaVersion: 10, actor: "yh" });
      expect(result.settings.sources).toEqual({
        pubmed: false,
        ctgov: false,
        eacts: false,
        esc: false,
        contactEmail: "",
        timeoutSeconds: 20,
        maxResults: 20,
      });
      expect(result.settings.schemaVersion).toBe(12);
      expect(result.settings.actor).toBe("yh");
    });

    it("leaves the guideline sources off on an upgrade from v11", () => {
      // The same rule, one version later: somebody already using PubMed does
      // not thereby start talking to two society web servers.
      const result = migrateSettings({
        schemaVersion: 11,
        sources: { pubmed: true, ctgov: false, contactEmail: "a@b.org" },
      });
      expect(result.settings.sources.pubmed).toBe(true);
      expect(result.settings.sources.eacts).toBe(false);
      expect(result.settings.sources.esc).toBe(false);
      expect(result.settings.schemaVersion).toBe(12);
      expect(result.notes.join(" ")).toContain("v11 -> v12");
    });

    it("refuses a stored value that is not exactly true", () => {
      // A hand-edited `data.json` carrying "yes" or 1 is not consent.
      const result = migrateSettings({
        schemaVersion: 11,
        sources: { eacts: "yes", esc: 1 },
      });
      expect(result.settings.sources.eacts).toBe(false);
      expect(result.settings.sources.esc).toBe(false);
    });

    it("keeps the switches the user actually set", () => {
      const result = migrateSettings({
        schemaVersion: 11,
        sources: { pubmed: true, ctgov: false, contactEmail: " a@b.org " },
      });
      expect(result.settings.sources.pubmed).toBe(true);
      expect(result.settings.sources.ctgov).toBe(false);
      expect(result.settings.sources.contactEmail).toBe("a@b.org");
    });

    it("turns everything off when the block is not readable", () => {
      // The only safe reading of a corrupt sources block is the one that makes
      // no requests, so it is discarded rather than partially trusted.
      const result = migrateSettings({ schemaVersion: 11, sources: "all of them" });
      expect(result.settings.sources.pubmed).toBe(false);
      expect(result.settings.sources.ctgov).toBe(false);
      expect(result.notes.join(" ")).toContain("left off");
    });

    it("does not treat a truthy non-boolean as consent", () => {
      const result = migrateSettings({
        schemaVersion: 11,
        sources: { pubmed: "yes", ctgov: 1 },
      });
      expect(result.settings.sources.pubmed).toBe(false);
      expect(result.settings.sources.ctgov).toBe(false);
    });

    it("clamps the timeout and the result count", () => {
      const wild = migrateSettings({
        schemaVersion: 11,
        sources: { timeoutSeconds: 99999, maxResults: 100000 },
      }).settings.sources;
      expect(wild.timeoutSeconds).toBe(120);
      expect(wild.maxResults).toBe(50);

      const tiny = migrateSettings({
        schemaVersion: 11,
        sources: { timeoutSeconds: 0, maxResults: 0 },
      }).settings.sources;
      expect(tiny.timeoutSeconds).toBe(5);
      expect(tiny.maxResults).toBe(1);
    });

    it("holds no host, because settings cannot name one", () => {
      // The allowlist is a constant in domain/sources/gateway. If a host ever
      // becomes settable, this test is the one that should stop it.
      const stored = { schemaVersion: 11, sources: { host: "evil.example", hosts: ["x"] } };
      const sources = migrateSettings(stored).settings.sources as unknown as Record<string, unknown>;
      expect(sources["host"]).toBeUndefined();
      expect(sources["hosts"]).toBeUndefined();
    });
  });

});
