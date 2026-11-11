import { expect, test } from "bun:test";
import {
  EMPTY_SPLIT_VIEW,
  MAX_LEAVES,
  canDrop,
  clearCurrent,
  currentSlotIndex,
  dropOnPane,
  leafPanes,
  multiSpace,
  nextOpenPane,
  normalizeSplitView,
  openPane,
  parseSplitView,
  removeTab,
  serializeSplitView,
  slotIndexOf,
  startSplitView,
  syncSplitView,
  type SplitNode,
  type SplitView,
} from "./split-view";

const leaf = (pane: string): SplitNode => ({ kind: "leaf", pane });
const row = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "row", children });
const col = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "col", children });

const view = (
  openTabs: readonly string[],
  current: string | null,
  layout: SplitNode | null,
): SplitView => ({ openTabs, current, layout });

function existsAmong(ids: readonly string[]): (paneId: string) => boolean {
  return (paneId) => ids.includes(paneId);
}

test("the first visit opens what herdr focuses as one pane", () => {
  expect(startSplitView("w1:p1")).toEqual(view(["w1:p1"], "w1:p1", leaf("w1:p1")));
  expect(startSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
});

test("slot colors follow the leaf order, top-left to bottom-right", () => {
  const shown = view(
    ["w1:p1", "w1:p2", "w1:p3"],
    "w1:p2",
    row(col(leaf("w1:p1"), leaf("w1:p2")), leaf("w1:p3")),
  );
  expect(leafPanes(shown.layout)).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
  expect(slotIndexOf(shown, "w1:p2")).toBe(1);
  expect(currentSlotIndex(shown)).toBe(1);
  expect(currentSlotIndex(clearCurrent(shown))).toBe(-1);
});

test("opening a pane adds it to the right end of the history", () => {
  const first = openPane(EMPTY_SPLIT_VIEW, "w1:p1");
  const second = openPane(first, "w2:p1");
  expect(second.openTabs).toEqual(["w1:p1", "w2:p1"]);
  expect(second.current).toBe("w2:p1");
  // 木に 1 枚しか無ければ、開いたペインがその葉を置き換える。
  expect(second.layout).toEqual(leaf("w2:p1"));
});

test("opening a pane that is already shown only moves the selection", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", row(leaf("w1:p1"), leaf("w1:p2")));
  const again = openPane(shown, "w1:p1");
  expect(again.openTabs).toEqual(["w1:p1", "w1:p2"]);
  expect(again.current).toBe("w1:p1");
  expect(again.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p2")));
});

test("a tab outside the layout replaces the current leaf", () => {
  const shown = view(["w1:p1", "w2:p1"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = openPane(shown, "w2:p1");
  expect(next.layout).toEqual(row(leaf("w2:p1"), leaf("w1:p2")));
  expect(next.current).toBe("w2:p1");
});

test("a tab opened while nothing is current replaces the first leaf", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p9"], null, row(leaf("w1:p1"), leaf("w1:p2")));
  const next = openPane(shown, "w1:p9");
  expect(next.layout).toEqual(row(leaf("w1:p9"), leaf("w1:p2")));
  expect(next.current).toBe("w1:p9");
});

test("going back to the list keeps the history and the layout", () => {
  const shown = view(["w1:p1"], "w1:p1", leaf("w1:p1"));
  expect(clearCurrent(shown)).toEqual(view(["w1:p1"], null, leaf("w1:p1")));
});

test("the successor is the next tab, or the one before when there is no next", () => {
  expect(nextOpenPane(["w1:p1", "w1:p2", "w1:p3"], "w1:p1")).toBe("w1:p2");
  expect(nextOpenPane(["w1:p1", "w1:p2", "w1:p3"], "w1:p3")).toBe("w1:p2");
  expect(nextOpenPane(["w1:p1"], "w1:p1")).toBeNull();
  expect(nextOpenPane(["w1:p1", "w1:p2"], "w9:p9")).toBeNull();
});

test("removing the current tab collapses its leaf and selects the successor", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = removeTab(shown, "w1:p1");
  expect(next.openTabs).toEqual(["w1:p2"]);
  expect(next.layout).toEqual(leaf("w1:p2"));
  expect(next.current).toBe("w1:p2");
});

test("the successor outside the layout falls back to the first leaf", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p9"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = removeTab(shown, "w1:p1");
  // w1:p9 はタブにあるが木に無い。見えていないペインへ選択を移さない。
  expect(next.current).toBe("w1:p2");
  expect(next.layout).toEqual(leaf("w1:p2"));
});

test("removing a tab that is not current keeps the selection", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = removeTab(shown, "w1:p2");
  expect(next.current).toBe("w1:p1");
  expect(next.layout).toEqual(leaf("w1:p1"));
});

test("removing a nested leaf collapses only its split", () => {
  const shown = view(
    ["w1:p1", "w1:p2", "w1:p3"],
    "w1:p1",
    row(leaf("w1:p1"), col(leaf("w1:p2"), leaf("w1:p3"))),
  );
  const next = removeTab(shown, "w1:p2");
  expect(next.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p3")));
});

test("removing a leaf rebuilds instead of nesting the same axis", () => {
  // a の親 col が row[c,d] に畳まれると row の下に row が並ぶ。2 つずつに組み直す。
  const shown = view(
    ["a", "b", "c", "d"],
    "a",
    row(col(leaf("a"), row(leaf("c"), leaf("d"))), leaf("b")),
  );
  const next = removeTab(shown, "a");
  expect(next.layout).toEqual(row(col(leaf("c"), leaf("d")), leaf("b")));
});

test("a pane disappearing rebuilds instead of nesting the same axis", () => {
  const shown = view(
    ["a", "b", "c", "d"],
    "c",
    row(col(leaf("a"), row(leaf("c"), leaf("d"))), leaf("b")),
  );
  const next = syncSplitView(shown, existsAmong(["b", "c", "d"]));
  expect(next.layout).toEqual(row(col(leaf("c"), leaf("d")), leaf("b")));
  expect(next.current).toBe("c");
});

test("restoring rebuilds a split with three children", () => {
  const restored = parseSplitView(
    '{"openTabs":["a","b","c"],"current":"a","layout":{"kind":"split","dir":"row","children":[{"kind":"leaf","pane":"a"},{"kind":"leaf","pane":"b"},{"kind":"leaf","pane":"c"}]}}',
  );
  expect(restored.layout).toEqual(row(col(leaf("a"), leaf("b")), leaf("c")));
});

test("an edge drop requires the target to be a leaf", () => {
  const shown = view(["a", "b"], "a", row(leaf("a"), leaf("b")));
  expect(canDrop(shown, "x", "nope", "right")).toBe(false);
  expect(dropOnPane(shown, "x", "nope", "right")).toBe(shown);
});

test("removing the last leaf returns to the list", () => {
  const shown = view(["w1:p1"], "w1:p1", leaf("w1:p1"));
  expect(removeTab(shown, "w1:p1")).toEqual(view([], null, null));
});

test("dropping on the center swaps the two leaves and selects the moved pane", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = dropOnPane(shown, "w1:p1", "w1:p2", "center");
  expect(next.layout).toEqual(row(leaf("w1:p2"), leaf("w1:p1")));
  expect(next.current).toBe("w1:p1");
});

test("dropping a tab outside the layout on the center replaces the target", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const next = dropOnPane(shown, "w1:p3", "w1:p2", "center");
  expect(next.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p3")));
  expect(next.current).toBe("w1:p3");
  expect(next.openTabs).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
});

test("dropping on an edge splits the target in that direction", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  expect(dropOnPane(shown, "w1:p3", "w1:p2", "bottom").layout).toEqual(
    row(leaf("w1:p1"), col(leaf("w1:p2"), leaf("w1:p3"))),
  );
  expect(dropOnPane(shown, "w1:p3", "w1:p1", "top").layout).toEqual(
    row(col(leaf("w1:p3"), leaf("w1:p1")), leaf("w1:p2")),
  );
});

test("a stacked pair splits left and right", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", col(leaf("w1:p1"), leaf("w1:p2")));
  expect(dropOnPane(shown, "w1:p3", "w1:p2", "left").layout).toEqual(
    col(leaf("w1:p1"), row(leaf("w1:p3"), leaf("w1:p2"))),
  );
});

test("moving a pane to an edge removes it first and then splits the target", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  // 左のペインを右の下へ移す。左が畳まれてから右の下へ入る。
  expect(dropOnPane(shown, "w1:p1", "w1:p2", "bottom").layout).toEqual(
    col(leaf("w1:p2"), leaf("w1:p1")),
  );
});

test("a split along the parent axis is rejected", () => {
  // 左列が 2 段、右が 1 段。左の 1 枚を隣の右へ出すと同じ向きのネストになる。
  const shown = view(
    ["w1:p1", "w1:p2", "w1:p3"],
    "w1:p1",
    row(col(leaf("w1:p1"), leaf("w1:p2")), leaf("w1:p3")),
  );
  expect(canDrop(shown, "w1:p1", "w1:p2", "right")).toBe(false);
  expect(canDrop(shown, "w1:p1", "w1:p2", "top")).toBe(true);
  expect(dropOnPane(shown, "w1:p1", "w1:p2", "right")).toBe(shown);
});

test("the layout stops at four panes", () => {
  const full = view(
    ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p9"],
    "w1:p1",
    row(col(leaf("w1:p1"), leaf("w1:p2")), col(leaf("w1:p3"), leaf("w1:p4"))),
  );
  expect(leafPanes(full.layout)).toHaveLength(MAX_LEAVES);
  // 木の外からは増やせない。
  expect(canDrop(full, "w1:p9", "w1:p1", "left")).toBe(false);
  expect(dropOnPane(full, "w1:p9", "w1:p1", "left")).toBe(full);
  // 木の中の移動は枚数が変わらないのでできる。
  expect(canDrop(full, "w1:p1", "w1:p2", "top")).toBe(true);
});

test("dragging the shown pane onto its own edge splits with the previous tab", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", leaf("w1:p2"));
  expect(canDrop(shown, "w1:p2", "w1:p2", "center")).toBe(false);
  expect(dropOnPane(shown, "w1:p2", "w1:p2", "center")).toBe(shown);
  const right = dropOnPane(shown, "w1:p2", "w1:p2", "right");
  expect(right.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p2")));
  expect(right.current).toBe("w1:p2");
  expect(right.openTabs).toEqual(["w1:p1", "w1:p2"]);
  // 端は落とした側へ動かす。元のセルには別のタブが残る。
  expect(dropOnPane(shown, "w1:p2", "w1:p2", "top").layout).toEqual(
    col(leaf("w1:p2"), leaf("w1:p1")),
  );
});

test("a self split takes the next tab in the open history", () => {
  const shown = view(["a", "b", "c"], "b", leaf("b"));
  const right = dropOnPane(shown, "b", "b", "right");
  expect(right.layout).toEqual(row(leaf("c"), leaf("b")));
  expect(right.current).toBe("b");
});

test("a self split needs a tab outside the layout to fill the vacated cell", () => {
  const single = view(["w1:p1"], "w1:p1", leaf("w1:p1"));
  expect(canDrop(single, "w1:p1", "w1:p1", "right")).toBe(false);
  expect(dropOnPane(single, "w1:p1", "w1:p1", "right")).toBe(single);
  const pair = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  expect(canDrop(pair, "w1:p1", "w1:p1", "bottom")).toBe(false);
});

test("a self split skips tabs that are already shown", () => {
  const shown = view(["a", "b", "c"], "c", row(leaf("b"), leaf("c")));
  // c の次に開いていた b は既に木にある。空くセルには a が入る。
  expect(dropOnPane(shown, "c", "c", "bottom").layout).toEqual(
    row(leaf("b"), col(leaf("a"), leaf("c"))),
  );
});

test("a self split along the parent axis is rejected", () => {
  const shown = view(["a", "b", "c"], "b", row(leaf("a"), leaf("b")));
  expect(canDrop(shown, "b", "b", "right")).toBe(false);
  expect(canDrop(shown, "b", "b", "top")).toBe(true);
});

test("a self split stops at four panes", () => {
  const full = view(
    ["a", "b", "c", "d", "e"],
    "a",
    row(col(leaf("a"), leaf("b")), col(leaf("c"), leaf("d"))),
  );
  expect(canDrop(full, "a", "a", "bottom")).toBe(false);
});

test("restoring drops gone panes and collapses their splits", () => {
  const shown = view(
    ["w1:p1", "w1:p2", "w1:p3"],
    "w1:p1",
    row(leaf("w1:p1"), col(leaf("w1:p2"), leaf("w1:p3"))),
  );
  const next = syncSplitView(shown, existsAmong(["w1:p1", "w1:p3"]));
  expect(next.openTabs).toEqual(["w1:p1", "w1:p3"]);
  expect(next.layout).toEqual(row(leaf("w1:p1"), leaf("w1:p3")));
});

test("a gone current pane keeps its id and comes back into the first leaf", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p2")));
  const gone = syncSplitView(shown, existsAmong(["w1:p2"]));
  expect(gone.current).toBe("w1:p1");
  expect(gone.layout).toEqual(leaf("w1:p2"));
  const back = syncSplitView(gone, existsAmong(["w1:p1", "w1:p2"]));
  expect(back.current).toBe("w1:p1");
  // 戻ってきた current は最初の葉を置き換える。元の位置は覚えていない。
  expect(back.layout).toEqual(leaf("w1:p1"));
});

test("restoring keeps the selection when the tree is empty", () => {
  const next = normalizeSplitView(view(["w1:p1"], "w1:p1", null), () => true);
  expect(next.layout).toEqual(leaf("w1:p1"));
});

test("restoring drops duplicates and extra leaves", () => {
  const duplicate = view(["w1:p1", "w1:p2"], "w1:p1", row(leaf("w1:p1"), leaf("w1:p1")));
  expect(normalizeSplitView(duplicate, () => true).layout).toEqual(leaf("w1:p1"));
  const extra = view(
    ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5"],
    "w1:p1",
    row(col(leaf("w1:p1"), leaf("w1:p2")), col(leaf("w1:p3"), leaf("w1:p5"))),
  );
  expect(leafPanes(normalizeSplitView(extra, () => true).layout)).toEqual([
    "w1:p1",
    "w1:p2",
    "w1:p3",
    "w1:p5",
  ]);
});

test("saving and restoring keeps the tree and the selection", () => {
  const shown = view(
    ["w1:p1", "w1:p2", "w1:p3"],
    "w1:p2",
    row(leaf("w1:p1"), col(leaf("w1:p2"), leaf("w1:p3"))),
  );
  expect(parseSplitView(serializeSplitView(shown))).toEqual(shown);
});

test("a broken saved value starts empty", () => {
  expect(parseSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("{")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("[]")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView('{"openTabs":"w1:p1","current":3,"layout":{}}')).toEqual({
    openTabs: [],
    current: null,
    layout: null,
  });
});

test("the old slot form is read as a single pane", () => {
  // ADR 0061 で形が変わる前の保存値。layout が無いので移行しない。
  const restored = parseSplitView(
    '{"openTabs":["w1:p1","w1:p2"],"current":"w1:p2","slots":["w1:p1","w1:p2"]}',
  );
  expect(restored).toEqual({ openTabs: ["w1:p1", "w1:p2"], current: "w1:p2", layout: null });
  expect(normalizeSplitView(restored, () => true).layout).toEqual(leaf("w1:p2"));
});

test("restoring drops an invalid split but keeps the other child", () => {
  const restored = parseSplitView(
    '{"openTabs":["w1:p1","w1:p2"],"current":"w1:p1","layout":{"kind":"split","dir":"row","children":[{"kind":"leaf","pane":"w1:p1"},"bad"]}}',
  );
  expect(restored.layout).toEqual(leaf("w1:p1"));
});

test("tabs opened in several spaces keep their order", () => {
  let next = EMPTY_SPLIT_VIEW;
  for (const paneId of ["w1:p1", "w2:p1", "w3:p1", "w1:p2"]) next = openPane(next, paneId);
  expect(next.openTabs).toEqual(["w1:p1", "w2:p1", "w3:p1", "w1:p2"]);
  expect(multiSpace(["w1", "w2"])).toBe(true);
  expect(multiSpace(["w1", "w1"])).toBe(false);
});
