import { expect, test } from "bun:test";
import {
  clockSkew,
  finishedClock,
  formatClock,
  formatElapsed,
  serverClockNow,
  workingMs,
} from "./time";

test("elapsed reads as seconds, minutes and hours", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(9_400)).toBe("9s");
  expect(formatElapsed(61_000)).toBe("1m 1s");
  expect(formatElapsed(59 * 60_000)).toBe("59m 0s");
  expect(formatElapsed(3_600_000)).toBe("1h 0m");
  expect(formatElapsed(2 * 3_600_000 + 2 * 60_000 + 5_000)).toBe("2h 2m");
  expect(formatElapsed(-5_000)).toBe("0s");
});

test("a message time reads as hours and minutes", () => {
  expect(formatClock(new Date(2026, 10, 2, 9, 5).getTime())).toBe("09:05");
  expect(formatClock(new Date(2026, 10, 2, 23, 59).getTime())).toBe("23:59");
});

test("the wait for a reply counts from the moment the pane started working", () => {
  const since = new Map([["w1:p1", 1_000]]);

  expect(workingMs(since, "w1:p1", 31_000)).toBe(30_000);
  // 覚えていないペインには経過を出さない。
  expect(workingMs(since, "w1:p2", 31_000)).toBeNull();
  // 端末の時計が戻っても負の値は出さない。
  expect(workingMs(since, "w1:p1", 0)).toBe(0);
});

test("a pane that finished shows when it finished, not how long ago", () => {
  const finished = new Map([["w1:p1", new Date(2026, 10, 2, 9, 5).getTime()]]);

  expect(finishedClock(finished, "w1:p1")).toBe("09:05");
  // 覚えていないペインには時刻を出さない。
  expect(finishedClock(finished, "w1:p2")).toBeNull();
});

test("the device clock is corrected by the server time it received", () => {
  // 端末の時計が 5 分進んでいる。
  const skew = clockSkew(1_000_000, 1_300_000, 0);

  expect(skew).toBe(300_000);
  // 表示用の「今」はサーバーの時計で進む。
  expect(serverClockNow(1_400_000, skew)).toBe(1_100_000);
});

test("a message without a readable server time keeps the previous skew", () => {
  expect(clockSkew(null, 1_300_000, 42)).toBe(42);
  expect(clockSkew(Number.NaN, 1_300_000, 42)).toBe(42);
});
