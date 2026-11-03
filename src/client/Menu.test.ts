import { expect, test } from "bun:test";
import { MENU_GAP, MENU_HEIGHT, MENU_MARGIN, MENU_MIN_WIDTH, menuPlacement } from "./Menu";

const viewport = { width: 390, height: 844 };

test("the menu sits just below the trigger when there is room", () => {
  const placement = menuPlacement(
    { bottom: 200, right: viewport.width - 24 },
    viewport,
    MENU_HEIGHT,
  );

  expect(placement).toEqual({ top: 200 + MENU_GAP, right: 24 });
});

test("the menu moves up when it would run off the bottom of the screen", () => {
  const placement = menuPlacement(
    { bottom: viewport.height - 10, right: 24 },
    viewport,
    MENU_HEIGHT,
  );

  expect(placement.top).toBe(viewport.height - MENU_HEIGHT - MENU_MARGIN);
});

test("the menu moves in when the trigger sits too close to the left edge", () => {
  // 右端をトリガーに合わせると、メニューの左端が画面からはみ出す幅しかない。
  const placement = menuPlacement({ bottom: 100, right: 100 }, viewport, MENU_HEIGHT);

  expect(placement.right).toBe(viewport.width - MENU_MIN_WIDTH - MENU_MARGIN);
});

test("the menu keeps its right edge on the trigger near the right edge", () => {
  const placement = menuPlacement({ bottom: 100, right: viewport.width }, viewport, MENU_HEIGHT);

  expect(placement.right).toBe(0);
});
