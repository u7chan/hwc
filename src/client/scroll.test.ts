import { expect, test } from "bun:test";
import { isLayoutShift, isNearBottom, isUserScrollDuringGrowth, revealScrollDelta } from "./scroll";

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

test("a scroll above the previous bottom while the content grows is the reader's", () => {
  // 8px 以内は底とみなす。伸びる前の高さで測るので、位置は今の scrollTop のまま。
  expect(isUserScrollDuringGrowth(box(1400, 600, 2100), box(1400, 600, 2000))).toBe(false);
  expect(isUserScrollDuringGrowth(box(1392, 600, 2100), box(1392, 600, 2000))).toBe(false);
  expect(isUserScrollDuringGrowth(box(1391, 600, 2100), box(1391, 600, 2000))).toBe(true);
});

test("growth alone, a resized box, or a shrink is not a reader's scroll", () => {
  expect(isUserScrollDuringGrowth(box(1391, 600, 2000), box(1391, 600, 2000))).toBe(false);
  expect(isUserScrollDuringGrowth(box(1391, 551, 2100), box(1391, 600, 2000))).toBe(false);
  expect(isUserScrollDuringGrowth(box(1391, 600, 1900), box(1391, 600, 2000))).toBe(false);
});

test("a row already inside the view does not move the list", () => {
  expect(revealScrollDelta({ top: 100, bottom: 164 }, { top: 0, bottom: 600 })).toBe(0);
  expect(revealScrollDelta({ top: 0, bottom: 64 }, { top: 0, bottom: 600 })).toBe(0);
  expect(revealScrollDelta({ top: 536, bottom: 600 }, { top: 0, bottom: 600 })).toBe(0);
});

test("a row above the view is pulled up to the top edge", () => {
  expect(revealScrollDelta({ top: -40, bottom: 24 }, { top: 0, bottom: 600 })).toBe(-40);
  expect(revealScrollDelta({ top: -400, bottom: -336 }, { top: 0, bottom: 600 })).toBe(-400);
});

test("a row below the view is pushed down to the bottom edge", () => {
  expect(revealScrollDelta({ top: 620, bottom: 684 }, { top: 0, bottom: 600 })).toBe(84);
});

test("a row that leaves the view on both sides is pulled up to the top edge", () => {
  expect(revealScrollDelta({ top: -20, bottom: 900 }, { top: 0, bottom: 600 })).toBe(-20);
});

test("a sticky head hides the top edge, so a row under it is pulled further up", () => {
  expect(revealScrollDelta({ top: 30, bottom: 100 }, { top: 0, bottom: 600 }, 56)).toBe(-26);
  expect(revealScrollDelta({ top: 56, bottom: 126 }, { top: 0, bottom: 600 }, 56)).toBe(0);
  expect(revealScrollDelta({ top: 500, bottom: 570 }, { top: 0, bottom: 600 }, 56)).toBe(0);
});
