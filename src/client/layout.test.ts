import { expect, test } from "bun:test";
import {
  DETAIL_MIN_WIDTH,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_STORAGE_KEY,
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  parseSidebarCollapsed,
  parseSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from "./layout";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function deniedStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
}

test("the sidebar never gets narrower than the list needs", () => {
  expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 100)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 100)).toBe(SIDEBAR_MAX_WIDTH);
  expect(clampSidebarWidth(400.4)).toBe(400);
  expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
});

test("the sidebar leaves the detail enough room", () => {
  const viewport = SIDEBAR_MAX_WIDTH + DETAIL_MIN_WIDTH - 100;
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, viewport)).toBe(viewport - DETAIL_MIN_WIDTH);
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, 900)).toBe(540);
  // 狭い画面でも下限は割らない。
  expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, 480)).toBe(SIDEBAR_MIN_WIDTH);
});

test("a stored width is restored and a broken one falls back", () => {
  expect(parseSidebarWidth("420")).toBe(420);
  expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(parseSidebarWidth("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(parseSidebarWidth("9999")).toBe(SIDEBAR_MAX_WIDTH);
  expect(parseSidebarWidth("9999", 900)).toBe(540);
});

test("the sidebar stays open unless it was stored as collapsed", () => {
  expect(parseSidebarCollapsed("true")).toBe(true);
  expect(parseSidebarCollapsed("false")).toBe(false);
  expect(parseSidebarCollapsed(null)).toBe(false);
  expect(parseSidebarCollapsed("collapsed")).toBe(false);
});

test("the sidebar keeps the storage keys its settings are read from", () => {
  expect(SIDEBAR_STORAGE_KEY).toBe("hwc-sidebar-width");
  expect(SIDEBAR_COLLAPSED_STORAGE_KEY).toBe("hwc-sidebar-collapsed");
});

test("the stored width keeps the format the app writes", () => {
  const store = memoryStorage();
  saveSidebarWidth(store, 400.4);

  expect(store.map.get(SIDEBAR_STORAGE_KEY)).toBe("400");
  expect(loadSidebarWidth(store)).toBe(400);
});

test("a width is clamped before it is written", () => {
  const wide = memoryStorage();
  saveSidebarWidth(wide, SIDEBAR_MAX_WIDTH + 100);
  expect(wide.map.get(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_MAX_WIDTH));

  const broken = memoryStorage();
  saveSidebarWidth(broken, Number.NaN);
  expect(broken.map.get(SIDEBAR_STORAGE_KEY)).toBe(String(SIDEBAR_DEFAULT_WIDTH));
});

test("an unreadable width falls back to the default", () => {
  expect(loadSidebarWidth(memoryStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "wide" }))).toBe(
    SIDEBAR_DEFAULT_WIDTH,
  );
  expect(loadSidebarWidth(deniedStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(loadSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(() => saveSidebarWidth(deniedStorage(), 400)).not.toThrow();
  expect(() => saveSidebarWidth(null, 400)).not.toThrow();
});

test("the collapsed flag is stored as true or false", () => {
  const store = memoryStorage();
  saveSidebarCollapsed(store, true);
  expect(store.map.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
  expect(loadSidebarCollapsed(store)).toBe(true);

  saveSidebarCollapsed(store, false);
  expect(store.map.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");
  expect(loadSidebarCollapsed(store)).toBe(false);
});

test("an unreadable collapsed flag leaves the list open", () => {
  expect(loadSidebarCollapsed(memoryStorage())).toBe(false);
  expect(
    loadSidebarCollapsed(memoryStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: "collapsed" })),
  ).toBe(false);
  expect(loadSidebarCollapsed(deniedStorage())).toBe(false);
  expect(loadSidebarCollapsed(null)).toBe(false);
  expect(() => saveSidebarCollapsed(deniedStorage(), true)).not.toThrow();
  expect(() => saveSidebarCollapsed(null, true)).not.toThrow();
});
