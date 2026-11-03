import { expect, test } from "bun:test";
import {
  DETAIL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  isCompactCell,
  isStackedCell,
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

// 分割セルの入力は、低いか上下に積まれた段で、幅が足りるときに 1 行に畳む。境目は見た目で
// 確かめにくいのでここで固定する（559/560 と 499/500）。
test("a split cell folds its composer when it is low or stacked and wide enough", () => {
  expect(isCompactCell(559, 500, false)).toBe(true);
  expect(isCompactCell(560, 500, false)).toBe(false);
  expect(isCompactCell(700, 500, false)).toBe(false);
  expect(isCompactCell(494, 499, false)).toBe(false);
  expect(isCompactCell(494, 500, false)).toBe(true);
  expect(isCompactCell(494, 550, false)).toBe(true);
  // 計測前（0）は畳まない。一瞬だけ 1 行になってから戻るのを避ける。
  expect(isCompactCell(0, 0, false)).toBe(false);
  expect(isCompactCell(400, 0, false)).toBe(false);
  // 積まれた段は高さを見ない。高いモニタで 560px を超えても畳む。
  expect(isCompactCell(700, 611, true)).toBe(true);
  expect(isCompactCell(700, 611, false)).toBe(false);
  // 幅の規則は積まれた段にも掛かる。1 行に収まらない幅では畳まない。
  expect(isCompactCell(700, 499, true)).toBe(false);
  expect(isCompactCell(0, 0, true)).toBe(false);
});

// 上下に積まれるのは 3 枚の右列と 4 枚の全部。並べ方は枚数で決まる。
test("only cells in a two-row split that do not span count as stacked", () => {
  expect(isStackedCell(1, 0)).toBe(false);
  expect(isStackedCell(2, 0)).toBe(false);
  expect(isStackedCell(2, 1)).toBe(false);
  expect(isStackedCell(3, 0)).toBe(false);
  expect(isStackedCell(3, 1)).toBe(true);
  expect(isStackedCell(3, 2)).toBe(true);
  expect(isStackedCell(4, 0)).toBe(true);
  expect(isStackedCell(4, 1)).toBe(true);
  expect(isStackedCell(4, 2)).toBe(true);
  expect(isStackedCell(4, 3)).toBe(true);
});
