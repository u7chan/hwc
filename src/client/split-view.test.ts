import { expect, test } from "bun:test";
import {
  EMPTY_SPLIT_VIEW,
  MAX_LEAVES,
  activePanes,
  canDrop,
  clearCurrent,
  dropOnPane,
  focusedLeaf,
  insertDelegatedPane,
  layoutKey,
  leafOfPane,
  moveTab,
  multiSpace,
  normalizeSplitView,
  openPane,
  openTabs,
  parseSplitView,
  readingOrder,
  removeTab,
  serializeSplitView,
  startSplitView,
  startsPaneDrag,
  successorTab,
  syncSplitView,
  treeTabs,
  type SplitLeaf,
  type SplitNode,
  type SplitView,
} from "./split-view";

const leaf = (tabs: readonly string[], active: string = tabs[0] ?? ""): SplitLeaf => ({
  kind: "leaf",
  tabs,
  active,
});
const row = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "row", children });
const col = (...children: SplitNode[]): SplitNode => ({ kind: "split", dir: "col", children });
const view = (current: string | null, layout: SplitNode | null): SplitView => ({ current, layout });

function existsAmong(ids: readonly string[]): (paneId: string) => boolean {
  return (paneId) => ids.includes(paneId);
}

test("the first visit opens what herdr focuses as one pane", () => {
  expect(startSplitView("w1:p1")).toEqual(view("w1:p1", leaf(["w1:p1"])));
  expect(startSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
});

test("the reading order sorts leaves by row, then column", () => {
  const byColumns = row(col(leaf(["a"]), leaf(["b"])), col(leaf(["c"]), leaf(["d"])));
  const byRows = col(row(leaf(["a"]), leaf(["b"])), row(leaf(["c"]), leaf(["d"])));
  // 構造順は木の作り方で変わるが、表示はどちらも行優先。
  expect(treeTabs(byColumns)).toEqual(["a", "b", "c", "d"]);
  expect(readingOrder(byColumns).map((item) => item.active)).toEqual(["a", "c", "b", "d"]);
  expect(readingOrder(byRows).map((item) => item.active)).toEqual(["a", "b", "c", "d"]);
  expect(openTabs(view("a", byColumns))).toEqual(["a", "c", "b", "d"]);
  expect(activePanes(view("a", byColumns))).toEqual(["a", "c", "b", "d"]);
});

test("opening a pane that is not open appends a tab to the focused leaf", () => {
  const first = openPane(EMPTY_SPLIT_VIEW, "w1:p1");
  const second = openPane(first, "w2:p1");
  expect(second).toEqual(view("w2:p1", leaf(["w1:p1", "w2:p1"], "w2:p1")));
  expect(openTabs(second)).toEqual(["w1:p1", "w2:p1"]);
});

test("opening with no current leaf uses the first leaf", () => {
  const shown = view(null, row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(openPane(shown, "c")).toEqual(view("c", row(leaf(["a", "c"], "c"), leaf(["b"], "b"))));
});

test("opening a pane already in another leaf focuses that leaf", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(openPane(shown, "b")).toEqual(view("b", row(leaf(["a"]), leaf(["b"], "b"))));
});

test("selecting the active tab again does not change the view", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(openPane(shown, "a")).toBe(shown);
});

test("removing a non-active tab keeps the active tab and the selection", () => {
  const shown = view("a", leaf(["a", "b"], "a"));
  expect(removeTab(shown, "b")).toEqual(view("a", leaf(["a"], "a")));
});

test("removing the active tab selects the next tab in the same leaf", () => {
  const shown = view("b", leaf(["a", "b", "c"], "b"));
  expect(removeTab(shown, "b")).toEqual(view("c", leaf(["a", "c"], "c")));
});

test("removing the last active tab selects the previous tab", () => {
  const shown = view("c", leaf(["a", "b", "c"], "c"));
  expect(removeTab(shown, "c")).toEqual(view("b", leaf(["a", "b"], "b")));
});

test("removing a tab from a non-focused leaf moves that leaf's active", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b", "c"], "b")));
  expect(removeTab(shown, "b")).toEqual(view("a", row(leaf(["a"]), leaf(["c"], "c"))));
});

test("a supplied successor is used while the leaf remains", () => {
  const shown = view("b", leaf(["a", "b", "c"], "b"));
  expect(removeTab(shown, "b", "a")).toEqual(view("a", leaf(["a", "c"], "a")));
  // 消えた後継は採らず、同じ葉の次のタブへ落とす。
  expect(removeTab(shown, "b", "z")).toEqual(view("c", leaf(["a", "c"], "c")));
});

test("removing the current tab of a collapsed leaf selects the next leaf", () => {
  const shown = view("b", row(leaf(["a"], "a"), leaf(["b"], "b"), leaf(["c"], "c")));
  expect(removeTab(shown, "b")).toEqual(view("c", row(leaf(["a"]), leaf(["c"]))));
});

test("removing the current tab of the last leaf selects the previous leaf", () => {
  const shown = view("c", row(leaf(["a"], "a"), leaf(["c"], "c")));
  expect(removeTab(shown, "c")).toEqual(view("a", leaf(["a"])));
});

test("removing the only tab returns to the list", () => {
  expect(removeTab(view("a", leaf(["a"])), "a")).toEqual(EMPTY_SPLIT_VIEW);
});

test("removing a nested leaf collapses only its split", () => {
  const shown = view("a", row(leaf(["a"], "a"), col(leaf(["b"], "b"), leaf(["c"], "c"))));
  expect(removeTab(shown, "b")).toEqual(view("a", row(leaf(["a"]), leaf(["c"]))));
});

test("removing a leaf rebuilds instead of nesting the same axis", () => {
  // a の親 col が row[c,d] に畳まれると row の下に row が並ぶ。2 つずつに組み直す。
  const shown = view("a", row(col(leaf(["a"]), row(leaf(["c"]), leaf(["d"]))), leaf(["b"])));
  expect(removeTab(shown, "a").layout).toEqual(row(col(leaf(["c"]), leaf(["d"])), leaf(["b"])));
});

test("the successor is the tab after the removed one, then before it", () => {
  const shown = view("b", leaf(["a", "b", "c"], "b"));
  expect(successorTab(shown, "b")).toBe("c");
  expect(successorTab(shown, "c")).toBe("b");
  expect(successorTab(shown, "a")).toBe("b");
  expect(successorTab(view("a", leaf(["a"])), "a")).toBeNull();
  expect(successorTab(shown, "z")).toBeNull();
});

test("going back to the list keeps the cells and the tabs", () => {
  const shown = view("a", leaf(["a"], "a"));
  expect(clearCurrent(shown)).toEqual(view(null, leaf(["a"], "a")));
});

test("moving a tab inside its own leaf only reorders it", () => {
  const shown = view("a", leaf(["a", "b", "c"], "a"));
  expect(moveTab(shown, "a", "c", "after")).toEqual(view("a", leaf(["b", "c", "a"], "a")));
  expect(moveTab(shown, "c", "a", "before")).toEqual(view("a", leaf(["c", "a", "b"], "a")));
  // 並びが変わらないときは同じ値を返し、保存と再描画を起こさない。
  expect(moveTab(shown, "a", "b", "before")).toBe(shown);
  expect(moveTab(shown, "a", "a", "after")).toBe(shown);
});

test("a gap drop selects the moved tab even in the same leaf", () => {
  const shown = view("a", leaf(["a", "b"], "a"));
  // タブの上では並べ替えだけで、選択は動かさない。
  expect(moveTab(shown, "b", "a", "before")).toEqual(view("a", leaf(["b", "a"], "a")));
  // 隙間への差し込みは、同じ葉でも移したペインを選ぶ。
  expect(moveTab(shown, "b", "a", "before", true)).toEqual(view("b", leaf(["b", "a"], "b")));
  expect(moveTab(shown, "a", "a", "after", true)).toEqual(view("a", leaf(["a", "b"], "a")));
});

test("moving a tab to another leaf inserts it at the side and focuses it", () => {
  const shown = view("b", row(leaf(["a", "b"], "b"), leaf(["c"], "c")));
  expect(moveTab(shown, "b", "c", "after")).toEqual(
    view("b", row(leaf(["a"], "a"), leaf(["c", "b"], "b"))),
  );
  expect(moveTab(shown, "b", "c", "before")).toEqual(
    view("b", row(leaf(["a"], "a"), leaf(["b", "c"], "b"))),
  );
});

test("moving the last tab of a leaf collapses that leaf", () => {
  const shown = view("b", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(moveTab(shown, "a", "b", "after")).toEqual(view("a", leaf(["b", "a"], "a")));
});

test("moving a tab from the list inserts it without a source leaf", () => {
  const shown = view("a", leaf(["a"], "a"));
  expect(moveTab(shown, "c", "a", "before")).toEqual(view("c", leaf(["c", "a"], "c")));
});

test("the cell center moves a tab to the end and selects it", () => {
  const shown = view("a", leaf(["a", "b"], "a"));
  expect(dropOnPane(shown, "a", "b", "center")).toEqual(view("a", leaf(["b", "a"], "a")));
  const other = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(dropOnPane(other, "a", "b", "center")).toEqual(view("a", leaf(["b", "a"], "a")));
});

test("an edge drop splits the target leaf and selects the moved pane", () => {
  const shown = view("a", leaf(["a"], "a"));
  expect(dropOnPane(shown, "c", "a", "right")).toEqual(
    view("c", row(leaf(["a"], "a"), leaf(["c"], "c"))),
  );
  expect(dropOnPane(shown, "c", "a", "bottom")).toEqual(
    view("c", col(leaf(["a"], "a"), leaf(["c"], "c"))),
  );
});

test("moving a pane to an edge removes it before splitting", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(dropOnPane(shown, "a", "b", "bottom")).toEqual(
    view("a", col(leaf(["b"], "b"), leaf(["a"], "a"))),
  );
});

test("a pane can split its own leaf when another tab stays behind", () => {
  const shown = view("b", leaf(["a", "b"], "b"));
  expect(dropOnPane(shown, "b", "b", "right")).toEqual(
    view("b", row(leaf(["a"], "a"), leaf(["b"], "b"))),
  );
  expect(dropOnPane(shown, "b", "b", "top")).toEqual(
    view("b", col(leaf(["b"], "b"), leaf(["a"], "a"))),
  );
});

test("a sole tab cannot split its own leaf", () => {
  const shown = view("a", leaf(["a"], "a"));
  expect(canDrop(shown, "a", "a", "right")).toBe(false);
  expect(dropOnPane(shown, "a", "a", "right")).toBe(shown);
  expect(canDrop(shown, "a", "a", "center")).toBe(true);
});

test("a split along the parent axis is rejected", () => {
  const shown = view("a", row(col(leaf(["a"], "a"), leaf(["b"], "b")), leaf(["c"], "c")));
  expect(canDrop(shown, "a", "b", "right")).toBe(false);
  expect(canDrop(shown, "a", "b", "top")).toBe(true);
  expect(dropOnPane(shown, "a", "b", "right")).toBe(shown);
});

test("an edge drop requires the target to be a leaf", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(canDrop(shown, "x", "nope", "right")).toBe(false);
  expect(dropOnPane(shown, "x", "nope", "right")).toBe(shown);
});

test("the layout stops at four leaves while a leaf can hold any number of tabs", () => {
  const full = view(
    "a",
    row(col(leaf(["a"], "a"), leaf(["b"], "b")), col(leaf(["c"], "c"), leaf(["d"], "d"))),
  );
  expect(readingOrder(full.layout)).toHaveLength(MAX_LEAVES);
  expect(canDrop(full, "e", "a", "left")).toBe(false);
  expect(dropOnPane(full, "e", "a", "left")).toBe(full);
  // 木の中の移動は枚数が変わらないのでできる。
  expect(canDrop(full, "a", "b", "top")).toBe(true);

  const many = view("x", leaf(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], "x"));
  expect(openTabs(many)).toHaveLength(10);
  expect(leafOfPane(many.layout, "j")?.tabs).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
  ]);
});

test("a tab missing from the snapshot is dropped and its leaf collapses", () => {
  const shown = view("a", row(leaf(["a"]), col(leaf(["b"]), leaf(["c"]))));
  const next = syncSplitView(shown, existsAmong(["a", "c"]));
  expect(next).toEqual(view("a", row(leaf(["a"]), leaf(["c"]))));
});

test("a gone active tab moves the leaf to the next remaining tab", () => {
  const shown = view("b", leaf(["a", "b", "c"], "b"));
  // current は消えた ID として保持し、葉の active だけが次のタブへ移る。
  expect(syncSplitView(shown, existsAmong(["a", "c"]))).toEqual(view("b", leaf(["a", "c"], "c")));
});

test("a gone current keeps its id and comes back into the first leaf", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  const gone = syncSplitView(shown, existsAmong(["b"]));
  expect(gone.current).toBe("a");
  expect(gone.layout).toEqual(leaf(["b"], "b"));
  const back = syncSplitView(gone, existsAmong(["a", "b"]));
  expect(back.current).toBe("a");
  expect(back.layout).toEqual(leaf(["b", "a"], "a"));
});

test("restoring keeps current and puts it back with the active tab", () => {
  const restored = normalizeSplitView(
    view("b", row(leaf(["a"], "a"), leaf(["b", "c"], "c"))),
    () => true,
  );
  expect(restored).toEqual(view("b", row(leaf(["a"], "a"), leaf(["b", "c"], "b"))));
});

test("restoring drops duplicates across the whole tree", () => {
  const duplicate = view("a", row(leaf(["a", "b"], "a"), leaf(["b", "c"], "b")));
  expect(normalizeSplitView(duplicate, () => true).layout).toEqual(
    row(leaf(["a", "b"], "a"), leaf(["c"], "c")),
  );
});

test("restoring fills a missing active from the same leaf", () => {
  const missing = view(null, leaf(["a", "b", "c"], "z"));
  expect(normalizeSplitView(missing, () => true).layout).toEqual(leaf(["a", "b", "c"], "a"));
});

test("restoring keeps at most four leaves and re-adds the current tab", () => {
  const five = view("e", row(leaf(["a"]), leaf(["b"]), leaf(["c"]), leaf(["d"]), leaf(["e"])));
  const next = normalizeSplitView(five, () => true);
  expect(readingOrder(next.layout).map((item) => item.tabs)).toEqual([
    ["a", "e"],
    ["c"],
    ["b"],
    ["d"],
  ]);
  expect(next.current).toBe("e");
  expect(leafOfPane(next.layout, "e")?.active).toBe("e");
});

test("restoring with no current keeps all leaves unfocused", () => {
  const next = normalizeSplitView(view(null, row(leaf(["a"]), leaf(["b"]))), () => true);
  expect(next).toEqual(view(null, row(leaf(["a"]), leaf(["b"]))));
});

test("restoring creates a leaf for a current pane missing from the tree", () => {
  const next = normalizeSplitView(view("a", null), () => true);
  expect(next).toEqual(view("a", leaf(["a"])));
});

test("restoring a gone current keeps the id and drops the pane from the tree", () => {
  const next = normalizeSplitView(view("z", leaf(["z", "a"], "z")), existsAmong(["a"]));
  expect(next).toEqual(view("z", leaf(["a"], "a")));
});

test("saving and restoring keeps the cells and the focus", () => {
  const shown = view("b", row(leaf(["a"], "a"), col(leaf(["b", "c"], "b"), leaf(["d"], "d"))));
  expect(parseSplitView(serializeSplitView(shown))).toEqual(shown);
});

test("a saved split with three children is rebuilt", () => {
  const restored = parseSplitView(
    '{"current":"a","layout":{"kind":"split","dir":"row","children":[{"kind":"leaf","tabs":["a"],"active":"a"},{"kind":"leaf","tabs":["b"],"active":"b"},{"kind":"leaf","tabs":["c"],"active":"c"}]}}',
  );
  expect(restored.layout).toEqual(row(col(leaf(["a"]), leaf(["b"])), leaf(["c"])));
});

test("a broken saved value starts empty", () => {
  expect(parseSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("{")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("[]")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView('{"current":3,"layout":{}}')).toEqual(EMPTY_SPLIT_VIEW);
});

test("the old leaf form is not read; only current survives", () => {
  const restored = parseSplitView(
    '{"openTabs":["a","b"],"recent":["b","a"],"current":"b","layout":{"kind":"leaf","pane":"b"}}',
  );
  expect(restored).toEqual(view("b", null));
  expect(normalizeSplitView(restored, () => true)).toEqual(view("b", leaf(["b"])));
});

test("the old split form is not read; only current survives", () => {
  const restored = parseSplitView(
    '{"openTabs":["a","b"],"current":"a","layout":{"kind":"split","dir":"row","children":[{"kind":"leaf","pane":"a"},{"kind":"leaf","pane":"b"}]}}',
  );
  expect(restored).toEqual(view("a", null));
  expect(normalizeSplitView(restored, () => true)).toEqual(view("a", leaf(["a"])));
});

test("restoring drops an invalid child but keeps the other leaf", () => {
  const restored = parseSplitView(
    '{"current":"a","layout":{"kind":"split","dir":"row","children":[{"kind":"leaf","tabs":["a"],"active":"a"},"bad"]}}',
  );
  expect(restored.layout).toEqual(leaf(["a"]));
});

test("a new save ignores the old openTabs and recent keys", () => {
  const parsed = parseSplitView(
    '{"openTabs":["a"],"recent":["a"],"current":"a","layout":{"kind":"leaf","tabs":["a"],"active":"a"}}',
  );
  expect(parsed).toEqual(view("a", leaf(["a"])));
  expect(serializeSplitView(parsed)).toBe(
    '{"current":"a","layout":{"kind":"leaf","tabs":["a"],"active":"a"}}',
  );
});

test("a delegated pane grows right, then below, then becomes a tab", () => {
  const first = view("a", leaf(["a"], "a"));
  const two = insertDelegatedPane(first, "b", "a");
  expect(two.layout).toEqual(row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(two.current).toBe("a");

  const three = insertDelegatedPane(two, "c", "a");
  expect(three.layout).toEqual(row(col(leaf(["a"], "a"), leaf(["c"], "c")), leaf(["b"], "b")));
  expect(three.current).toBe("a");

  const four = insertDelegatedPane(three, "d", "a");
  // フォーカス中の a を割る。親が col なので右へ分け、row(a, d) が左列に入る。
  expect(four.layout).toEqual(
    row(col(row(leaf(["a"], "a"), leaf(["d"], "d")), leaf(["c"], "c")), leaf(["b"], "b")),
  );
  expect(four.current).toBe("a");

  const five = insertDelegatedPane(four, "e", "a");
  expect(leafOfPane(five.layout, "e")?.tabs).toEqual(["a", "e"]);
  expect(five.current).toBe("a");
});

test("a delegated pane already in a leaf does not move", () => {
  const shown = view("a", row(leaf(["a"], "a"), leaf(["b"], "b")));
  expect(insertDelegatedPane(shown, "b", "a")).toBe(shown);
});

test("a delegated pane targets the leaf that contains its Herdr tab", () => {
  const shown = view("a", row(leaf(["a", "c"], "a"), leaf(["b"], "b")));
  // c は active ではないが同じ葉にある。その葉（先頭）を割る。
  const next = insertDelegatedPane(shown, "d", "c");
  expect(readingOrder(next.layout).map((item) => item.tabs)).toEqual([["a", "c"], ["b"], ["d"]]);
});

test("multiSpace is true only when the tabs span spaces", () => {
  expect(multiSpace(["w1", "w2"])).toBe(true);
  expect(multiSpace(["w1", "w1"])).toBe(false);
});

test("the layout key changes with tab order but not with active", () => {
  const a = view("a", leaf(["a", "b"], "a"));
  const b = view("b", leaf(["a", "b"], "b"));
  const moved = view("a", leaf(["b", "a"], "a"));
  expect(layoutKey(a.layout)).toBe(layoutKey(b.layout));
  expect(layoutKey(a.layout)).not.toBe(layoutKey(moved.layout));
  expect(layoutKey(null)).toBe("null");
});

test("the focused leaf follows current, then falls back to the first leaf", () => {
  const layout = row(leaf(["a"], "a"), leaf(["b"], "b"));
  expect(focusedLeaf(view("b", layout))?.active).toBe("b");
  expect(focusedLeaf(view("z", layout))?.active).toBe("a");
  expect(focusedLeaf(view(null, layout))?.active).toBe("a");
  expect(focusedLeaf(EMPTY_SPLIT_VIEW)).toBeNull();
});

test("a list drag on touch starts only toward the cell", () => {
  // 移動量が足りない間はクリックとして扱う。
  expect(startsPaneDrag("mouse", false, 5, 0)).toBe(false);
  // マウスは向きを問わず、少し動けば始める。
  expect(startsPaneDrag("mouse", true, -10, 0)).toBe(true);
  // 触れる画面の一覧は、縦の動きをスクロールに譲る。
  expect(startsPaneDrag("touch", true, 2, 10)).toBe(false);
  expect(startsPaneDrag("touch", true, 10, 10)).toBe(false);
  // セルの方（右）へ向かう横の動きだけが開始になる。
  expect(startsPaneDrag("touch", true, -10, 2)).toBe(false);
  expect(startsPaneDrag("touch", true, 10, 2)).toBe(true);
  // 一覧以外（タブ・セルの見出し）は縦の移動でも始められる。
  expect(startsPaneDrag("touch", false, 0, 10)).toBe(true);
});
