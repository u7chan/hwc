import { expect, test } from "bun:test";
import { MENU_GAP, MENU_MARGIN, MENU_MIN_WIDTH, menuPlacement } from "./Menu";

const viewport = { width: 390, height: 844 };
const MENU_HEIGHT = 96;

test("the menu sits just below the trigger when there is room", () => {
  const placement = menuPlacement(
    { top: 100, bottom: 200, right: viewport.width - 24 },
    viewport,
    MENU_HEIGHT,
  );

  expect(placement).toEqual({ top: 200 + MENU_GAP, right: 24 });
});

test("the menu moves up when it would run off the bottom of the screen", () => {
  const placement = menuPlacement(
    { top: viewport.height - 50, bottom: viewport.height - 10, right: 24 },
    viewport,
    MENU_HEIGHT,
  );

  expect(placement.top).toBe(viewport.height - MENU_HEIGHT - MENU_MARGIN);
});

test("the menu moves in when the trigger sits too close to the left edge", () => {
  // 右端をトリガーに合わせると、メニューの左端が画面からはみ出す幅しかない。
  const placement = menuPlacement({ top: 50, bottom: 100, right: 100 }, viewport, MENU_HEIGHT);

  expect(placement.right).toBe(viewport.width - MENU_MIN_WIDTH - MENU_MARGIN);
});

test("the menu leaves a margin at the right edge", () => {
  const placement = menuPlacement(
    { top: 50, bottom: 100, right: viewport.width },
    viewport,
    MENU_HEIGHT,
  );

  expect(placement.right).toBe(MENU_MARGIN);
});

test("a menu wider than the minimum uses its measured width", () => {
  const placement = menuPlacement({ top: 50, bottom: 100, right: 100 }, viewport, 340, 300);

  expect(placement.right).toBe(viewport.width - 300 - MENU_MARGIN);
});

test("a tall menu stays below the top margin in a short viewport", () => {
  const placement = menuPlacement(
    { top: 100, bottom: 200, right: 300 },
    { width: 320, height: 240 },
    300,
    304,
  );

  expect(placement).toEqual({ top: MENU_MARGIN, right: MENU_MARGIN });
});

test("a menu above the trigger ends just above it", () => {
  const placement = menuPlacement(
    { top: 700, bottom: 744, right: viewport.width - 8 },
    viewport,
    MENU_HEIGHT,
    220,
    "above",
  );

  expect(placement).toEqual({ top: 700 - MENU_GAP - MENU_HEIGHT, right: 8 });
});

test("an above menu stays below the top margin", () => {
  const placement = menuPlacement(
    { top: 20, bottom: 64, right: 24 },
    viewport,
    MENU_HEIGHT,
    220,
    "above",
  );

  expect(placement.top).toBe(MENU_MARGIN);
});
