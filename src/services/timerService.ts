/**
 * The running timer (CLAUDE.md §7 B2).
 *
 * Owns three things and nothing else: the persisted state, the heartbeat, and
 * the order in which questions get asked. All the arithmetic is in
 * `domain/effort/timer`, and every dialog arrives as a callback — this module
 * imports no UI, so the state machine can be driven from a test or a command
 * palette entry without a modal in sight.
 *
 * **Persistence is the crash-safety story.** State is written on every change
 * and on every heartbeat, so an Obsidian crash costs at most one beat. Nothing
 * here keeps a session in memory alone: memory is exactly what a crash reaches.
 */

import { Notice, type App } from "obsidian";
import type { TimeEntry } from "../domain/effort/entry";
import { validateEntry } from "../domain/effort/entry";
import {
  applyRecovery,
  beatTimer,
  elapsedMs,
  idleGapMs,
  pauseTimer,
  recoverTimer,
  resolveIdleGap,
  resumeTimer,
  startTimer,
  HEARTBEAT_MS,
  MIN_IDLE_MINUTES,
  timerEntry,
  type IdleChoice,
  type RecoveryChoice,
  type TimerBinding,
  type TimerRecovery,
  type TimerState,
} from "../domain/effort/timer";
import { formatMinutes } from "../domain/effort/aggregate";
import { MINUTE_MS } from "../domain/time/dates";
import type { ScdbSettings } from "../domain/settings/schema";
import type { EffortLog } from "./effortLog";

export { HEARTBEAT_MS };

export type StopOutcome =
  | { kind: "save"; entry: TimeEntry }
  | { kind: "discard" }
  | { kind: "cancel" };

export interface TimerServiceDeps {
  app: App;
  log: EffortLog;
  settings: () => ScdbSettings;
  /** Persist settings, including the timer. Awaited on every state change. */
  save: () => Promise<void>;
  /** Repaint the status bar and any open board. */
  refresh: () => void;
  /** Show the entry about to be written, editable. */
  askStop: (entry: TimeEntry, title: string) => Promise<StopOutcome>;
  /** Keep, discard or split a gap. Null when the user closes the dialog. */
  askIdle: (gapMs: number, state: TimerState) => Promise<IdleChoice | null>;
  /** What to do with a timer found still going at startup. */
  askRecovery: (recovery: TimerRecovery) => Promise<RecoveryChoice | null>;
}

export class TimerService {
  /** Guards against a second dialog while one is open, and against re-entrant ticks. */
  private asking = false;

  constructor(private readonly deps: TimerServiceDeps) {}

  current(): TimerState | null {
    return this.deps.settings().effort.timer;
  }

  elapsed(now = Date.now()): number {
    const state = this.current();
    return state === null ? 0 : elapsedMs(state, now);
  }

  private async persist(state: TimerState | null): Promise<void> {
    this.deps.settings().effort.timer = state;
    await this.deps.save();
    this.deps.refresh();
  }

  /* ------------------------------------------------------------ driving -- */

  async start(binding: TimerBinding, now = Date.now()): Promise<void> {
    if (this.current() !== null) {
      new Notice("A timer is already running. Stop it first, or change what it is bound to.", 5000);
      return;
    }
    await this.persist(startTimer(binding, now));
    new Notice(`Timer started: ${binding.ref.trim() || binding.activity}.`, 3000);
  }

  async pause(now = Date.now()): Promise<void> {
    const state = this.current();
    if (state === null || state.status !== "running") return;
    await this.persist(pauseTimer(state, now));
  }

  async resume(now = Date.now()): Promise<void> {
    const state = this.current();
    if (state === null || state.status !== "paused") return;
    await this.persist(resumeTimer(state, now));
  }

  async toggle(now = Date.now()): Promise<void> {
    const state = this.current();
    if (state === null) return;
    if (state.status === "running") await this.pause(now);
    else await this.resume(now);
  }

  /** Change what the running timer is bound to, without losing its minutes. */
  async rebind(binding: TimerBinding): Promise<void> {
    const state = this.current();
    if (state === null) return;
    await this.persist({ ...state, binding });
  }

  /**
   * Stop, show what will be written, and write it.
   *
   * The dialog is not a confirmation — it is the last chance to fix the
   * activity and the note while the session is still in mind. Cancelling leaves
   * the timer exactly as it was, running or paused, because "I meant to pause"
   * must not cost the session.
   */
  async stop(now = Date.now()): Promise<void> {
    const state = this.current();
    if (state === null || this.asking) return;

    const worked = elapsedMs(state, now);
    if (worked < MINUTE_MS) {
      // Rounding this up to a minute would be inventing time. Saying so and
      // clearing is the honest outcome, and the common case is a misclick.
      await this.persist(null);
      new Notice("Under a minute — the timer was cleared and nothing was recorded.", 5000);
      return;
    }

    const draft = timerEntry(state, now, worked);
    this.asking = true;
    try {
      const outcome = await this.deps.askStop(draft, "Stop timer");
      if (outcome.kind === "cancel") return;
      if (outcome.kind === "discard") {
        await this.persist(null);
        new Notice(`Timer discarded. ${formatMinutes(draft.mins)} was not recorded.`, 5000);
        return;
      }
      await this.write(outcome.entry);
      await this.persist(null);
    } finally {
      this.asking = false;
    }
  }

  /** Write one entry, refusing rather than writing something the log cannot read. */
  async write(entry: TimeEntry): Promise<void> {
    const reasons = validateEntry(entry, this.deps.log.vocabularies().activities);
    if (reasons.length > 0) {
      new Notice(`That entry was not recorded:\n${reasons.join("\n")}`, 9000);
      throw new Error(reasons[0]);
    }
    await this.deps.log.append([entry]);
    const against = entry.ref.trim() === "" ? entry.activity : entry.ref.trim();
    new Notice(`${formatMinutes(entry.mins)} recorded against ${against}.`, 4000);
  }

  /* ---------------------------------------------------------- heartbeat -- */

  /**
   * One beat.
   *
   * When the gap since the last beat is longer than the machine being briefly
   * busy would explain, the user is asked what happened before anything is
   * banked. §7 B2: never silently record, never silently discard. Both are
   * decisions, and neither is ours.
   */
  async tick(now = Date.now()): Promise<void> {
    const state = this.current();
    if (state === null || this.asking) return;

    // Floored at two beats regardless of the setting: a threshold at or below
    // the heartbeat would fire on every ordinary tick, and a dialog that asks
    // the same question once a minute is one people answer without reading.
    const threshold =
      Math.max(MIN_IDLE_MINUTES, this.deps.settings().effort.idleMinutes) * MINUTE_MS;
    const gap = idleGapMs(state, now, threshold);
    if (gap === null) {
      const beaten = beatTimer(state, now);
      if (beaten !== state) await this.persist(beaten);
      else this.deps.refresh();
      return;
    }

    this.asking = true;
    try {
      const choice = await this.deps.askIdle(gap, state);
      // Closing the dialog decides nothing, so the timer is left as it was and
      // the same question comes back on the next beat. An unanswered question
      // is better than an answer nobody gave.
      if (choice === null) return;

      const resolved = resolveIdleGap(state, now, choice);
      if (resolved.entry !== null) {
        if (resolved.entry.mins > 0) await this.write(resolved.entry);
      }
      await this.persist(resolved.state);
    } finally {
      this.asking = false;
    }
  }

  /* ----------------------------------------------------------- recovery -- */

  /**
   * A timer found still going at startup.
   *
   * Both totals are offered because only the user knows which is true: Obsidian
   * closing at 11:00 on a session started at 09:00 could be two hours of work
   * or two hours of a closed laptop, and no API here can tell them apart.
   */
  async recoverOnLoad(now = Date.now()): Promise<void> {
    const recovery = recoverTimer(this.current(), now);
    if (recovery === null || this.asking) return;

    this.asking = true;
    try {
      const choice = await this.deps.askRecovery(recovery);
      if (choice === null) return; // asked again next start; nothing decided, nothing lost
      const result = applyRecovery(recovery, choice, now);
      if (result.entry !== null) {
        if (result.entry.mins > 0) await this.write(result.entry);
        // Asked to record, and there was nothing to record. Saying so beats a
        // dialog that closes and leaves the user wondering where the entry went.
        else new Notice("That session was under a minute, so nothing was recorded.", 5000);
      }
      await this.persist(result.state);
    } finally {
      this.asking = false;
    }
  }
}
