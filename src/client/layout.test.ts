import { expect, test } from "bun:test";
import {
  DETAIL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  isCompactCell,
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

// 分割セルの入力は、低くて幅が足りるときだけ 1 行に畳む。境目は見た目で確かめにくいので
// ここで固定する（559/560 と 499/500）。
test("a split cell folds its composer only when it is low and wide enough", () => {
  expect(isCompactCell(559, 500)).toBe(true);
  expect(isCompactCell(560, 500)).toBe(false);
  expect(isCompactCell(700, 500)).toBe(false);
  expect(isCompactCell(494, 499)).toBe(false);
  expect(isCompactCell(494, 500)).toBe(true);
  expect(isCompactCell(494, 550)).toBe(true);
  // 計測前（0）は畳まない。一瞬だけ 1 行になってから戻るのを避ける。
  expect(isCompactCell(0, 0)).toBe(false);
  expect(isCompactCell(400, 0)).toBe(false);
});
