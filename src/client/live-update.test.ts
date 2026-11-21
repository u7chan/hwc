import { expect, test } from "bun:test";
import {
  DEFAULT_LIVE_UPDATE,
  LIVE_UPDATE_OPTIONS,
  LIVE_UPDATE_STORAGE_KEY,
  liveUpdateAllowed,
  liveUpdateLabel,
  liveUpdateMs,
  loadLiveUpdate,
  parseLiveUpdate,
  saveLiveUpdate,
} from "./live-update";

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

test("the default interval is three seconds", () => {
  expect(DEFAULT_LIVE_UPDATE).toBe("3s");
  expect(parseLiveUpdate(null)).toBe("3s");
  expect(liveUpdateMs("3s")).toBe(3_000);
  expect(liveUpdateLabel("3s")).toBe("3 秒");
});

test("every interval survives a round trip", () => {
  const storage = memory(null);
  for (const option of LIVE_UPDATE_OPTIONS) {
    saveLiveUpdate(storage, option.id);
    expect(storage.current()).toBe(option.id);
    expect(loadLiveUpdate(storage)).toBe(option.id);
  }
  expect(storage.current()).toBe("10s");
});

test("off is an explicit interval, not a broken value", () => {
  expect(parseLiveUpdate("off")).toBe("off");
  expect(liveUpdateMs("off")).toBe(0);
  expect(liveUpdateLabel("off")).toBe("オフ");
});

test("an unknown value falls back to the default", () => {
  expect(parseLiveUpdate("")).toBe("3s");
  expect(parseLiveUpdate("2s")).toBe("3s");
});

test("a hidden document does not refresh", () => {
  expect(liveUpdateAllowed("hidden")).toBe(false);
  expect(liveUpdateAllowed("visible")).toBe(true);
});

test("an unreadable store keeps the default", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  expect(loadLiveUpdate(broken)).toBe("3s");
  expect(loadLiveUpdate(null)).toBe("3s");
});

test("a store that rejects writes is ignored", () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(() => saveLiveUpdate(broken, "5s")).not.toThrow();
});

test("the setting keeps one storage key", () => {
  expect(LIVE_UPDATE_STORAGE_KEY).toBe("hwc-live-update");
});
