import { expect, test } from "bun:test";
import { planSplit } from "./split";

test("a wide cell splits to the right so both halves stay landscape", () => {
  const plan = planSplit([{ paneId: "w1:p1", width: 240, height: 48 }]);

  expect(plan).toEqual({ paneId: "w1:p1", direction: "right", ratio: 0.5 });
});

test("a tall cell splits down so both halves stay portrait", () => {
  const plan = planSplit([{ paneId: "w1:p1", width: 47, height: 60 }]);

  expect(plan).toEqual({ paneId: "w1:p1", direction: "down", ratio: 0.5 });
});

test("the first cell wins when the areas are equal", () => {
  const plan = planSplit([
    { paneId: "w1:p1", width: 100, height: 47 },
    { paneId: "w1:p2", width: 100, height: 47 },
  ]);

  expect(plan?.paneId).toBe("w1:p1");
});

test("the largest cell is split first, so an L-shape becomes 2x2 on the fourth pane", () => {
  const plan = planSplit([
    { paneId: "w1:p1", width: 50, height: 23 },
    { paneId: "w1:p2", width: 50, height: 23 },
    { paneId: "w1:p3", width: 100, height: 47 },
  ]);

  expect(plan).toEqual({ paneId: "w1:p3", direction: "down", ratio: 0.5 });
});

test("splitting the right and down sides equally prefers the right", () => {
  // セル比 0.48 で 140x48 はちょうど目標アスペクト 1.4。どちらに割っても同じ距離になる。
  const plan = planSplit([{ paneId: "w1:p1", width: 140, height: 48 }]);

  expect(plan?.direction).toBe("right");
});

test("a tall tab stacks panes instead of forcing a 2x2", () => {
  // 60x48 のタブは幅を保つために 1 列のまま下へ積む。横長の 2x2 にはしない。
  const first = planSplit([{ paneId: "w1:p1", width: 60, height: 48 }]);
  expect(first?.direction).toBe("down");

  const second = planSplit([
    { paneId: "w1:p1", width: 60, height: 24 },
    { paneId: "w1:p2", width: 60, height: 24 },
  ]);
  expect(second?.direction).toBe("down");
});

test("no pane is created once the tab has four", () => {
  const cells = [1, 2, 3, 4].map((index) => ({
    paneId: `w1:p${index}`,
    width: 60,
    height: 24,
  }));

  expect(planSplit(cells)).toBeNull();
});

test("an empty layout has nothing to split", () => {
  expect(planSplit([])).toBeNull();
});
