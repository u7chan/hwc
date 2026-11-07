import { expect, test } from "bun:test";
import {
  ACTIVITY_MAX_AGE_MS,
  ACTIVITY_TEXT_LIMIT,
  LIVE_PHASES,
  activityTextTail,
  isLivePhase,
  parseActivityFile,
  parsePaneActivity,
  type PaneActivity,
} from "./activity";

const now = 1_800_000_000_000;

const thinking = (value: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  at: now,
  phase: "thinking",
  text: "考えている",
  ...value,
});

test("accepts the v1 document and normalizes empty optional fields", () => {
  expect(parseActivityFile(thinking(), now)).toEqual({
    phase: "thinking",
    text: "考えている",
    tool: null,
    tools: 1,
    at: now,
  } satisfies PaneActivity);
  expect(parseActivityFile({ v: 1, at: now, phase: "writing", text: "無視" }, now)).toEqual({
    phase: "writing",
    text: "",
    tool: null,
    tools: 1,
    at: now,
  });
  expect(
    parseActivityFile({ v: 1, at: now, phase: "tool", tool: "bash", tools: 2, text: "無視" }, now),
  ).toEqual({ phase: "tool", text: "", tool: "bash", tools: 2, at: now });
});

test("rejects documents that are not the v1 activity contract", () => {
  for (const value of [
    null,
    [],
    "thinking",
    { at: now, phase: "thinking" },
    { v: 2, at: now, phase: "thinking" },
    { v: 1, at: now, phase: "unknown" },
    { v: 1, at: "now", phase: "thinking" },
    { v: 1, at: Number.NaN, phase: "thinking" },
  ]) {
    expect(parseActivityFile(value, now)).toBeNull();
  }
});

test("drops a sidecar that is too old or from the future", () => {
  expect(parseActivityFile(thinking({ at: now - ACTIVITY_MAX_AGE_MS - 1 }), now)).toBeNull();
  expect(parseActivityFile(thinking({ at: now + ACTIVITY_MAX_AGE_MS + 1 }), now)).toBeNull();
  // 長いツール実行中は更新が止まる。境界の内側は残す。
  expect(
    parseActivityFile(thinking({ at: now - ACTIVITY_MAX_AGE_MS + 1_000 }), now),
  ).not.toBeNull();
});

test("caps text and tool values instead of trusting the writer", () => {
  const long = "あ".repeat(ACTIVITY_TEXT_LIMIT + 10);
  const parsed = parseActivityFile(thinking({ text: long }), now);
  expect(Array.from(parsed?.text ?? "")).toHaveLength(ACTIVITY_TEXT_LIMIT);
  expect(
    parseActivityFile({ v: 1, at: now, phase: "tool", tool: "x".repeat(200), tools: 1_000 }, now),
  ).toMatchObject({
    tool: "x".repeat(64),
    tools: 99,
  });
  expect(parseActivityFile({ v: 1, at: now, phase: "tool", tools: -3 }, now)).toMatchObject({
    tools: 1,
    tool: null,
  });
});

test("keeps the newest code points when trimming the tail", () => {
  expect(activityTextTail("abcdef", 3)).toBe("def");
  expect(activityTextTail("a😀b", 2)).toBe("😀b");
  expect(activityTextTail("abc", 0)).toBe("");
});

test("the wire shape has no version and is normalized again on the client", () => {
  expect(
    parsePaneActivity({ phase: "thinking", text: "考", tool: null, tools: 0, at: now }, now),
  ).toEqual({ phase: "thinking", text: "考", tool: null, tools: 1, at: now });
  expect(parsePaneActivity({ phase: "writing", at: now }, now)?.phase).toBe("writing");
  expect(parsePaneActivity({ v: 1, at: now, phase: "thinking" }, now)).not.toBeNull();
  expect(parsePaneActivity({ phase: "bogus", at: now }, now)).toBeNull();
  expect(parsePaneActivity(null, now)).toBeNull();
});

test("recognizes every published phase", () => {
  for (const phase of LIVE_PHASES) {
    expect(isLivePhase(phase)).toBe(true);
    expect(parseActivityFile({ v: 1, at: now, phase }, now)?.phase).toBe(phase);
  }
  expect(isLivePhase("idle")).toBe(false);
});
