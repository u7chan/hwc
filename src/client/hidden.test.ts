import { expect, test } from "bun:test";
import { parseHiddenPanes, toggleHiddenPanes } from "./hidden";

test("a missing or broken preference hides nothing", () => {
  expect(parseHiddenPanes(null).size).toBe(0);
  expect(parseHiddenPanes("").size).toBe(0);
  expect(parseHiddenPanes("{").size).toBe(0);
  expect(parseHiddenPanes('{"pane":"w1:p1"}').size).toBe(0);
  // 別の版が書いた想定外の値は捨てて、表示が消えない側に倒す。
  expect([...parseHiddenPanes('["w1:p1", 3, null]')]).toEqual(["w1:p1"]);
});

test("the stored panes round-trip through the preference", () => {
  const stored = parseHiddenPanes('["w1:p2","w1:p3"]');
  expect([...stored]).toEqual(["w1:p2", "w1:p3"]);
  expect([...parseHiddenPanes(JSON.stringify([...stored]))]).toEqual(["w1:p2", "w1:p3"]);
});

test("toggling a pane keeps the other panes as they are", () => {
  const once = toggleHiddenPanes(new Set(), "w1:p2");
  expect([...once]).toEqual(["w1:p2"]);
  expect([...toggleHiddenPanes(once, "w1:p3")]).toEqual(["w1:p2", "w1:p3"]);
  expect([...toggleHiddenPanes(toggleHiddenPanes(once, "w1:p3"), "w1:p2")]).toEqual(["w1:p3"]);
  // 元の集合は書き換えない。
  expect([...once]).toEqual(["w1:p2"]);
});
