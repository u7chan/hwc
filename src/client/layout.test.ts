import { expect, test } from "bun:test";
import {
  DETAIL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebarWidth,
} from "./layout";

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
