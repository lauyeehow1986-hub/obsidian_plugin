import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "../time/dates";
import {
  applyRecovery,
  beatTimer,
  elapsedMs,
  emptyBinding,
  formatElapsed,
  HEARTBEAT_MS,
  idleGapMs,
  MIN_IDLE_MINUTES,
  pauseTimer,
  recoverTimer,
  resolveIdleGap,
  resumeTimer,
  startTimer,
  timerEntry,
  timerLabel,
  type TimerBinding,
} from "./timer";

/** 2026-07-14 09:12 local — the worked example in §5.3. */
const NINE_TWELVE = new Date(2026, 6, 14, 9, 12).getTime();

function binding(overrides: Partial<TimerBinding> = {}): TimerBinding {
  return {
    ...emptyBinding("yh"),
    ref: "REQ-2026-014",
    activity: "scoping",
    study: "EuroHeart",
    ...overrides,
  };
}

const mins = (n: number) => n * MINUTE_MS;

describe("start, pause, resume", () => {
  it("counts the running segment", () => {
    const state = startTimer(binding(), NINE_TWELVE);
    expect(elapsedMs(state, NINE_TWELVE + mins(20))).toBe(mins(20));
  });

  it("stops counting while paused", () => {
    const paused = pauseTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(20));
    expect(elapsedMs(paused, NINE_TWELVE + mins(60))).toBe(mins(20));
  });

  it("banks each segment across a pause", () => {
    let state = startTimer(binding(), NINE_TWELVE);
    state = pauseTimer(state, NINE_TWELVE + mins(20));
    state = resumeTimer(state, NINE_TWELVE + mins(35));
    expect(elapsedMs(state, NINE_TWELVE + mins(53))).toBe(mins(38));
  });

  it("ignores a pause on a paused timer and a resume on a running one", () => {
    const running = startTimer(binding(), NINE_TWELVE);
    expect(resumeTimer(running, NINE_TWELVE + mins(5))).toBe(running);
    const paused = pauseTimer(running, NINE_TWELVE + mins(5));
    expect(pauseTimer(paused, NINE_TWELVE + mins(9))).toBe(paused);
  });

  it("moves nothing but the heartbeat", () => {
    // A heartbeat must never change how much time is on the clock — only how
    // much of it we can vouch for after a crash.
    const state = startTimer(binding(), NINE_TWELVE);
    const beaten = beatTimer(state, NINE_TWELVE + mins(1));
    expect(elapsedMs(beaten, NINE_TWELVE + mins(20))).toBe(mins(20));
    expect(beaten.beat).toBe(NINE_TWELVE + mins(1));
  });
});

describe("timerEntry", () => {
  it("writes the worked minutes, not the elapsed span", () => {
    let state = startTimer(binding(), NINE_TWELVE);
    state = pauseTimer(state, NINE_TWELVE + mins(20));
    state = resumeTimer(state, NINE_TWELVE + mins(35));
    const entry = timerEntry(state, NINE_TWELVE + mins(53));

    expect(entry).toMatchObject({
      date: "2026-07-14",
      start: "09:12",
      end: "10:05",
      mins: 38,
      person: "yh",
      ref: "REQ-2026-014",
      activity: "scoping",
    });
  });

  it("rounds rather than floors", () => {
    const state = startTimer(binding(), NINE_TWELVE);
    // Flooring would shave seconds off every entry in the same direction.
    expect(timerEntry(state, NINE_TWELVE + mins(89) + 40_000).mins).toBe(90);
  });

  it("attributes an overnight session to the day it started", () => {
    // Splitting it at midnight would put one session in two months' files.
    const lateStart = new Date(2026, 6, 14, 23, 40).getTime();
    const entry = timerEntry(startTimer(binding(), lateStart), lateStart + mins(40));
    expect(entry).toMatchObject({ date: "2026-07-14", start: "23:40", end: "00:20", mins: 40 });
  });
});

describe("idle gaps", () => {
  const threshold = mins(5);

  it("will not accept a threshold that fires on every heartbeat", () => {
    // The gap since the last beat is one heartbeat long by definition, so a
    // one-minute threshold would put the dialog on screen once a minute
    // forever — and a question asked that often is one nobody reads.
    expect(MIN_IDLE_MINUTES * MINUTE_MS).toBeGreaterThan(HEARTBEAT_MS);
  });

  it("notices a gap only once it is longer than the threshold", () => {
    const state = startTimer(binding(), NINE_TWELVE);
    expect(idleGapMs(state, NINE_TWELVE + mins(2), threshold)).toBeNull();
    expect(idleGapMs(state, NINE_TWELVE + mins(90), threshold)).toBe(mins(90));
  });

  it("does not ask about a gap in a paused timer", () => {
    // A paused timer is not counting, so a gap in it costs nothing.
    const paused = pauseTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(1));
    expect(idleGapMs(paused, NINE_TWELVE + mins(600), threshold)).toBeNull();
  });

  it("keeps the gap as worked when asked to", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(10));
    const now = NINE_TWELVE + mins(70);
    const { state: kept, entry } = resolveIdleGap(state, now, "keep");
    expect(entry).toBeNull();
    expect(elapsedMs(kept, now)).toBe(mins(70));
  });

  it("drops the gap and runs on when asked to discard", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(10));
    const now = NINE_TWELVE + mins(70);
    const { state: trimmed } = resolveIdleGap(state, now, "discard");
    expect(elapsedMs(trimmed, now)).toBe(mins(10));
    expect(elapsedMs(trimmed, now + mins(5))).toBe(mins(15));
  });

  it("closes an entry at the heartbeat and starts a fresh one when asked to split", () => {
    // "Came back to it after lunch" — one session before, one after.
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(10));
    const now = NINE_TWELVE + mins(70);
    const { state: fresh, entry } = resolveIdleGap(state, now, "split");

    expect(entry).toMatchObject({ start: "09:12", end: "09:22", mins: 10 });
    expect(fresh.startedAt).toBe(now);
    expect(elapsedMs(fresh, now)).toBe(0);
    expect(fresh.binding.ref).toBe("REQ-2026-014");
  });
});

describe("crash recovery", () => {
  it("offers both the vouched and the optimistic total", () => {
    // Obsidian crashing at 11:00 on a session started at 09:12 could be two
    // hours of work or two hours of a closed laptop. Only the user knows.
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(30));
    const recovery = recoverTimer(state, NINE_TWELVE + mins(120))!;
    expect(recovery.vouchedMs).toBe(mins(30));
    expect(recovery.optimisticMs).toBe(mins(120));
    expect(recovery.gapMs).toBe(mins(90));
  });

  it("has nothing to recover when no timer was running", () => {
    expect(recoverTimer(null, NINE_TWELVE)).toBeNull();
  });

  it("writes the vouched minutes by default", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(30));
    const recovery = recoverTimer(state, NINE_TWELVE + mins(120))!;
    const { state: after, entry } = applyRecovery(recovery, "heartbeat", NINE_TWELVE + mins(120));
    expect(after).toBeNull();
    expect(entry).toMatchObject({ start: "09:12", end: "09:42", mins: 30 });
  });

  it("can write the whole span when the user says it really ran", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(30));
    const recovery = recoverTimer(state, NINE_TWELVE + mins(120))!;
    expect(applyRecovery(recovery, "now", NINE_TWELVE + mins(120)).entry!.mins).toBe(120);
  });

  it("can carry on, keeping the vouched minutes and dropping the gap", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(30));
    const now = NINE_TWELVE + mins(120);
    const { state: resumed, entry } = applyRecovery(recoverTimer(state, now)!, "resume", now);
    expect(entry).toBeNull();
    expect(resumed!.status).toBe("running");
    expect(elapsedMs(resumed!, now + mins(5))).toBe(mins(35));
  });

  it("can throw the session away, writing nothing", () => {
    const state = beatTimer(startTimer(binding(), NINE_TWELVE), NINE_TWELVE + mins(30));
    const now = NINE_TWELVE + mins(120);
    expect(applyRecovery(recoverTimer(state, now)!, "discard", now)).toEqual({
      state: null,
      entry: null,
    });
  });
});

describe("what the status bar says", () => {
  it("stays legible as a live clock", () => {
    // Not formatDuration: that reports 100 minutes as "1 hour" and then says
    // the same for the next fifty-nine, which reads as a stopped timer.
    expect(formatElapsed(0)).toBe("0m");
    expect(formatElapsed(mins(53))).toBe("53m");
    expect(formatElapsed(mins(100))).toBe("1h 40m");
    expect(formatElapsed(mins(64))).toBe("1h 04m");
  });

  it("names what is being timed, and says when it is paused", () => {
    const state = startTimer(binding(), NINE_TWELVE);
    expect(timerLabel(state, NINE_TWELVE + mins(20))).toBe("20m · REQ-2026-014");
    expect(timerLabel(pauseTimer(state, NINE_TWELVE + mins(20)), NINE_TWELVE + mins(40))).toBe(
      "20m paused · REQ-2026-014",
    );
    expect(timerLabel(null, NINE_TWELVE)).toBe("No timer");
  });

  it("falls back to the activity when nothing is referenced", () => {
    const loose = startTimer(binding({ ref: "" }), NINE_TWELVE);
    expect(timerLabel(loose, NINE_TWELVE)).toBe("0m · scoping");
  });
});
