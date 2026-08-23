/**
 * The effort timer (CLAUDE.md §7 B2) — a state machine, not a stopwatch.
 *
 * Three requirements shape all of this, and each of them is a way the naive
 * version loses your morning:
 *
 *  - **Crash-safe.** Every state change and every heartbeat is persisted, so an
 *    Obsidian crash costs at most one heartbeat. The heartbeat is not a
 *    nicety: without it, a crash at 16:00 on a timer started at 09:00 leaves
 *    nothing but a start time, and the only honest thing to record would be
 *    nothing at all.
 *  - **Idle handling.** A machine that slept, locked or hibernated did not do
 *    seven hours of extraction. A gap between heartbeats is detected and
 *    *asked about* — keep, discard, or split — and never silently recorded and
 *    never silently dropped. Both silences are wrong in the same way: they
 *    decide something that was the user's to decide.
 *  - **Pauses are banked, not subtracted at the end.** `banked` accumulates
 *    closed segments and `segmentFrom` times the open one, so the recorded
 *    minutes are the minutes worked while the clock times still bound the
 *    whole session (see `entry.ts` on why both are stored).
 *
 * Everything here is pure and returns a new state; nothing schedules, persists
 * or asks. The service owns the heartbeat and the dialogs.
 */

import { MINUTE_MS } from "../time/dates";
import { formatClock, type TimeEntry } from "./entry";

export type TimerStatus = "running" | "paused";

/** What the entry will say. Chosen when the timer starts; editable on stop. */
export interface TimerBinding {
  person: string;
  /** A request id, a study, or free text. */
  ref: string;
  activity: string;
  study: string;
  costCentre: string;
  note: string;
}

/**
 * The persisted timer. Plain JSON — it is written to `data.json` on every
 * change, so it must survive being read back by a different plugin version.
 */
export interface TimerState {
  status: TimerStatus;
  binding: TimerBinding;
  /** Epoch ms of the very first start. Becomes the entry's `start`. */
  startedAt: number;
  /** Epoch ms the currently running segment began. Meaningless when paused. */
  segmentFrom: number;
  /** Ms banked from segments already closed. */
  banked: number;
  /** Epoch ms of the last heartbeat: the last moment we can vouch for. */
  beat: number;
}

export function emptyBinding(person = ""): TimerBinding {
  return { person, ref: "", activity: "", study: "", costCentre: "", note: "" };
}

export function startTimer(binding: TimerBinding, now: number): TimerState {
  return { status: "running", binding, startedAt: now, segmentFrom: now, banked: 0, beat: now };
}

/** Ms worked so far: banked segments plus the open one. */
export function elapsedMs(state: TimerState, now: number): number {
  const open = state.status === "running" ? Math.max(0, now - state.segmentFrom) : 0;
  return state.banked + open;
}

export function pauseTimer(state: TimerState, now: number): TimerState {
  if (state.status !== "running") return state;
  return {
    ...state,
    status: "paused",
    banked: elapsedMs(state, now),
    segmentFrom: now,
    beat: now,
  };
}

export function resumeTimer(state: TimerState, now: number): TimerState {
  if (state.status !== "paused") return state;
  return { ...state, status: "running", segmentFrom: now, beat: now };
}

/**
 * Record that the timer was still alive at `now`.
 *
 * The only field this moves is `beat`, so a heartbeat can never change how much
 * time is on the clock — it only changes how much of it we can vouch for after
 * a crash.
 */
export function beatTimer(state: TimerState, now: number): TimerState {
  return now > state.beat ? { ...state, beat: now } : state;
}

/**
 * The entry a timer stopped at `endedAt` would write.
 *
 * The date is the date the timer **started**, not the date it stopped: a
 * session that runs from 23:40 to 00:20 is one piece of Tuesday's work, and
 * splitting it across two months' files at midnight would be worse than the
 * ten minutes of misattribution.
 */
export function timerEntry(state: TimerState, endedAt: number, elapsed?: number): TimeEntry {
  const worked = elapsed ?? elapsedMs(state, endedAt);
  const started = new Date(state.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
  const clockOf = (ms: number) => {
    const d = new Date(ms);
    return formatClock(d.getHours() * 60 + d.getMinutes());
  };

  return {
    date,
    start: clockOf(state.startedAt),
    end: clockOf(endedAt),
    // Rounded, not floored: 89.6 minutes of work is 90, and floor would shave a
    // few seconds off every single entry in the same direction. A timer that
    // systematically under-reports is a timer that under-justifies a post.
    mins: Math.round(worked / MINUTE_MS),
    person: state.binding.person,
    ref: state.binding.ref,
    activity: state.binding.activity,
    study: state.binding.study,
    costCentre: state.binding.costCentre,
    note: state.binding.note,
  };
}

/* ------------------------------------------------------------ idle gaps -- */

/**
 * How long the timer went unheard from, when that is longer than the machine
 * being briefly busy would explain. Null when there is no gap worth asking
 * about, or when the timer is paused — a paused timer is not counting, so a gap
 * in it costs nothing.
 */
export function idleGapMs(state: TimerState, now: number, thresholdMs: number): number | null {
  if (state.status !== "running") return null;
  const gap = now - state.beat;
  return gap >= thresholdMs ? gap : null;
}

/**
 * How often the timer says it is still alive. One minute, matching B2's promise
 * that a crash loses at most a minute.
 */
export const HEARTBEAT_MS = 60_000;

/**
 * The shortest idle threshold that means anything.
 *
 * A threshold at or below the heartbeat fires on **every ordinary beat** — the
 * gap since the last beat is a heartbeat long by definition — so a one-minute
 * setting would put a dialog on screen once a minute forever. Two beats is the
 * floor at which a gap is evidence of something rather than of the clock.
 */
export const MIN_IDLE_MINUTES = 2;

export const IDLE_CHOICES = ["keep", "discard", "split"] as const;
export type IdleChoice = (typeof IDLE_CHOICES)[number];

export interface IdleResolution {
  state: TimerState;
  /** A completed entry, when the choice was to split. */
  entry: TimeEntry | null;
}

/**
 * Resolve a detected gap.
 *
 *  - `keep` — the gap was work (reading a paper, a phone call). Nothing moves
 *    but the heartbeat.
 *  - `discard` — the machine was away. The gap is dropped and the timer runs on
 *    from now, so the session keeps its identity and its earlier minutes.
 *  - `split` — the gap ended the session. An entry is closed at the last
 *    heartbeat and a fresh timer starts now with the same binding, which is
 *    what "came back to it after lunch" actually looks like in the log.
 *
 * There is no "decide for me". §7 B2: never silently record, never silently
 * discard.
 */
export function resolveIdleGap(
  state: TimerState,
  now: number,
  choice: IdleChoice,
): IdleResolution {
  if (state.status !== "running") return { state, entry: null };

  switch (choice) {
    case "keep":
      return { state: beatTimer(state, now), entry: null };

    case "discard":
      return {
        state: { ...state, banked: elapsedMs(state, state.beat), segmentFrom: now, beat: now },
        entry: null,
      };

    case "split": {
      const closedAt = state.beat;
      const entry = timerEntry(state, closedAt, elapsedMs(state, closedAt));
      return { state: startTimer(state.binding, now), entry };
    }
  }
}

/* ------------------------------------------------------- crash recovery -- */

export interface TimerRecovery {
  state: TimerState;
  /** Ms up to the last heartbeat — the part we can actually vouch for. */
  vouchedMs: number;
  /** Ms if the timer really did run until now. */
  optimisticMs: number;
  /** How long ago the last heartbeat was. */
  gapMs: number;
}

/**
 * A timer found still going at startup.
 *
 * Both numbers are offered because only the user knows which is true: Obsidian
 * crashing at 11:00 on a session that started at 09:00 could mean two hours of
 * work or two hours of a closed laptop, and the plugin has no way to tell. The
 * recovery dialog names both and defaults to the smaller.
 */
export function recoverTimer(state: TimerState | null, now: number): TimerRecovery | null {
  if (state === null) return null;
  return {
    state,
    vouchedMs: elapsedMs(state, state.beat),
    optimisticMs: elapsedMs(state, now),
    gapMs: Math.max(0, now - state.beat),
  };
}

export const RECOVERY_CHOICES = ["heartbeat", "now", "resume", "discard"] as const;
export type RecoveryChoice = (typeof RECOVERY_CHOICES)[number];

export interface RecoveryResult {
  /** The timer to carry on with, or null when it is over. */
  state: TimerState | null;
  entry: TimeEntry | null;
}

export function applyRecovery(
  recovery: TimerRecovery,
  choice: RecoveryChoice,
  now: number,
): RecoveryResult {
  const { state } = recovery;
  switch (choice) {
    case "heartbeat":
      return { state: null, entry: timerEntry(state, state.beat, recovery.vouchedMs) };
    case "now":
      return { state: null, entry: timerEntry(state, now, recovery.optimisticMs) };
    case "resume":
      // Keep the session, drop the unaccounted gap: banked up to the heartbeat,
      // running again from this moment.
      return {
        state: { ...state, status: "running", banked: recovery.vouchedMs, segmentFrom: now, beat: now },
        entry: null,
      };
    case "discard":
      return { state: null, entry: null };
  }
}

/* ------------------------------------------------------------ rendering -- */

/**
 * A running total for the status bar: `0m`, `53m`, `1h 04m`.
 *
 * Deliberately not `formatDuration`. That formatter is right for "23 days in
 * approval" but wrong for a live clock — it reports a 100-minute timer as
 * "1 hour" and then says the same thing for the next fifty-nine minutes, which
 * reads as a timer that has stopped. Minute resolution, no seconds: seconds
 * would mean repainting the status bar sixty times a minute for a number nobody
 * is watching that closely.
 */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** What the status bar says next to the glyph. */
export function timerLabel(state: TimerState | null, now: number): string {
  if (state === null) return "No timer";
  const time = formatElapsed(elapsedMs(state, now));
  const what = state.binding.ref.trim() || state.binding.activity.trim() || "untitled";
  return state.status === "paused" ? `${time} paused · ${what}` : `${time} · ${what}`;
}
