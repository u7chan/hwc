import { expect, test } from "bun:test";
import {
  DEFAULT_SPLIT_PREFS,
  loadSplitPrefs,
  parseSplitPrefs,
  saveSplitPrefs,
  serializeSplitPrefs,
  splitMotionDuration,
} from "./split-prefs";

function memory(initial: string | null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    current: () => value,
  };
}

test("an empty value starts with auto split on and the normal speed", () => {
  expect(parseSplitPrefs(null)).toEqual(DEFAULT_SPLIT_PREFS);
  expect(DEFAULT_SPLIT_PREFS).toEqual({ autoSplit: true, motion: "normal" });
});

test("both choices survive a round trip", () => {
  const prefs = { autoSplit: false, motion: "slow" as const };
  expect(parseSplitPrefs(serializeSplitPrefs(prefs))).toEqual(prefs);
});

test("a broken record falls back per field instead of dropping both", () => {
  expect(parseSplitPrefs('{"autoSplit":false,"motion":"instant"}')).toEqual({
    autoSplit: false,
    motion: "normal",
  });
  expect(parseSplitPrefs('{"autoSplit":"no","motion":"fast"}')).toEqual({
    autoSplit: true,
    motion: "fast",
  });
});

test("garbage and arrays are treated as unset", () => {
  expect(parseSplitPrefs("not json")).toEqual(DEFAULT_SPLIT_PREFS);
  expect(parseSplitPrefs("[]")).toEqual(DEFAULT_SPLIT_PREFS);
  expect(parseSplitPrefs("null")).toEqual(DEFAULT_SPLIT_PREFS);
});

test("the duration is the one the row promises", () => {
  expect(splitMotionDuration("off")).toBe(0);
  expect(splitMotionDuration("slow")).toBe(560);
  expect(splitMotionDuration("normal")).toBe(280);
  expect(splitMotionDuration("fast")).toBe(160);
});

test("an unreadable store keeps the default", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadSplitPrefs(broken)).toEqual(DEFAULT_SPLIT_PREFS);
  expect(() => saveSplitPrefs(broken, DEFAULT_SPLIT_PREFS)).not.toThrow();
  expect(loadSplitPrefs(null)).toEqual(DEFAULT_SPLIT_PREFS);
});

test("a saved value is read back from the store", () => {
  const store = memory(null);
  saveSplitPrefs(store, { autoSplit: false, motion: "fast" });
  expect(store.current()).toBe('{"autoSplit":false,"motion":"fast"}');
  expect(loadSplitPrefs(store)).toEqual({ autoSplit: false, motion: "fast" });
});
