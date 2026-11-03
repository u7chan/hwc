import { expect, test } from "bun:test";
import { isLayoutShift, isNearBottom } from "./scroll";

const box = (scrollTop: number, clientHeight = 600, scrollHeight = 2000) => ({
  scrollTop,
  clientHeight,
  scrollHeight,
});

test("the latest is near the bottom within a finger's error", () => {
  expect(isNearBottom(box(1400))).toBe(true);
  expect(isNearBottom(box(1392))).toBe(true);
  expect(isNearBottom(box(1391))).toBe(false);
  expect(isNearBottom(box(0))).toBe(false);
});

test("a shorter content than the box counts as the bottom", () => {
  expect(isNearBottom(box(0, 600, 300))).toBe(true);
});

test("a change of the content or the box height is a layout shift", () => {
  expect(isLayoutShift(box(1400, 600, 2000), box(1400, 600, 2000))).toBe(false);
  expect(isLayoutShift(box(1400, 600, 2100), box(1400, 600, 2000))).toBe(true);
  expect(isLayoutShift(box(1400, 551, 2000), box(1400, 600, 2000))).toBe(true);
});

test("the same content and box height means the reader moved", () => {
  expect(isLayoutShift(box(0, 600, 2000), box(1400, 600, 2000))).toBe(false);
});
