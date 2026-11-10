import { expect, test } from "bun:test";
import {
  EMPTY_SPLIT_VIEW,
  MAX_SLOTS,
  addToSlots,
  clearCurrent,
  closeEmptySlot,
  currentSlotIndex,
  dropOnSlot,
  multiSpace,
  nextOpenPane,
  normalizeSplitView,
  openPane,
  parseSplitView,
  placeInSlots,
  removeTab,
  serializeSplitView,
  slotIndexOf,
  startSplitView,
  syncSplitView,
  type SplitView,
} from "./split-view";

const view = (
  openTabs: readonly string[],
  current: string | null,
  slots: readonly (string | null)[],
): SplitView => ({ openTabs, current, slots });

const NO_PANES: readonly string[] = [];

function existsAmong(ids: readonly string[]): (paneId: string) => boolean {
  return (paneId) => ids.includes(paneId);
}

test("the first visit opens what herdr focuses as one slot", () => {
  expect(startSplitView("w1:p1")).toEqual(view(["w1:p1"], "w1:p1", ["w1:p1"]));
  expect(startSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
});

test("opening a pane adds it to the right end of the history", () => {
  const first = openPane(EMPTY_SPLIT_VIEW, "w1:p1");
  const second = openPane(first, "w2:p1");
  expect(second.openTabs).toEqual(["w1:p1", "w2:p1"]);
  expect(second.current).toBe("w2:p1");
  // 1 枚目は current のスロットを置き換える。履歴には残る。
  expect(second.slots).toEqual(["w2:p1"]);
});

test("opening a pane that is already open only moves the selection", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", ["w1:p1", "w1:p2"]);
  const again = openPane(shown, "w1:p1");
  expect(again.openTabs).toEqual(["w1:p1", "w1:p2"]);
  expect(again.current).toBe("w1:p1");
  expect(again.slots).toEqual(["w1:p1", "w1:p2"]);
});

test("reopening a removed pane stacks it at the right end", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", ["w1:p1", "w1:p2"]);
  const removed = removeTab(shown, "w1:p1");
  const reopened = openPane(removed, "w1:p1");
  expect(reopened.openTabs).toEqual(["w1:p2", "w1:p3", "w1:p1"]);
});

test("tabs keep the order they were opened in, across spaces", () => {
  let next = EMPTY_SPLIT_VIEW;
  for (const paneId of ["w1:p1", "w2:p1", "w3:p1", "w1:p2"]) next = openPane(next, paneId);
  expect(next.openTabs).toEqual(["w1:p1", "w2:p1", "w3:p1", "w1:p2"]);
});

test("a tab outside the grid replaces the current slot", () => {
  const shown = view(["w1:p1", "w2:p1"], "w1:p1", ["w1:p1"]);
  const next = openPane(shown, "w2:p1");
  expect(next.slots).toEqual(["w2:p1"]);
  expect(next.openTabs).toEqual(["w1:p1", "w2:p1"]);
});

test("a tab selected while nothing is current fills the first empty slot", () => {
  const shown = view(["w1:p1", "w1:p9"], null, ["w1:p1", null, "w1:p2"]);
  const next = openPane(shown, "w1:p9");
  // 空きがあればレイアウトを変えずに埋める。末尾にも 0 番にも足さない。
  expect(next.slots).toEqual(["w1:p1", "w1:p9", "w1:p2"]);
  expect(next.current).toBe("w1:p9");
});

test("a tab selected while nothing is current replaces slot 1 before growing the grid", () => {
  const shown = view(["w1:p1", "w1:p3", "w1:p9"], null, ["w1:p1", "w1:p3"]);
  const next = openPane(shown, "w1:p9");
  // 空きが無ければ 4 未満でも末尾に足さない。スロット 1 を置き換える（ADR 0058 の遷移表）。
  expect(next.slots).toEqual(["w1:p9", "w1:p3"]);
  expect(next.current).toBe("w1:p9");
});

test("a tab selected while nothing is current replaces slot 1 when the grid is full", () => {
  const shown = view(["w1:p1", "w1:p2"], null, ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
  const next = openPane(shown, "w1:p2");
  expect(next.slots).toEqual(["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
  const fresh = view(["w1:p1", "w1:p9"], null, ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
  expect(openPane(fresh, "w1:p9").slots).toEqual(["w1:p9", "w1:p2", "w1:p3", "w1:p4"]);
});

test("a tab selected while nothing is current starts the grid from one slot", () => {
  const next = openPane(view(["w1:p1"], null, []), "w1:p1");
  expect(next.slots).toEqual(["w1:p1"]);
});

test("going back to the list keeps the history and the grid", () => {
  const shown = view(["w1:p1"], "w1:p1", ["w1:p1"]);
  expect(clearCurrent(shown)).toEqual(view(["w1:p1"], null, ["w1:p1"]));
});

test("the successor is the next tab, or the one before when there is no next", () => {
  expect(nextOpenPane(["w1:p1", "w1:p2", "w1:p3"], "w1:p1")).toBe("w1:p2");
  expect(nextOpenPane(["w1:p1", "w1:p2", "w1:p3"], "w1:p3")).toBe("w1:p2");
  expect(nextOpenPane(["w1:p1"], "w1:p1")).toBeNull();
  expect(nextOpenPane(["w1:p1", "w1:p2"], "w9:p9")).toBeNull();
});

test("removing the current tab moves the selection into the empty slot", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", null]);
  const next = removeTab(shown, "w1:p1");
  expect(next.openTabs).toEqual(["w1:p2"]);
  expect(next.current).toBe("w1:p2");
  // 後継はグリッド外だったので、外したペインのスロットへ入る。
  expect(next.slots).toEqual(["w1:p2", null]);
});

test("removing the current tab picks a successor already in the grid without moving it", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = removeTab(shown, "w1:p1");
  expect(next.current).toBe("w1:p2");
  expect(next.slots).toEqual([null, "w1:p2"]);
});

test("removing the current tab with no successor goes back to the list", () => {
  const shown = view(["w1:p1"], "w1:p1", ["w1:p1"]);
  expect(removeTab(shown, "w1:p1")).toEqual(view([], null, [null]));
});

test("removing a tab that is not current leaves the selection alone", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = removeTab(shown, "w1:p2");
  expect(next.current).toBe("w1:p1");
  // 外したタブのスロットは空きとして残る（空きスロットの × でだけ詰める）。
  expect(next.slots).toEqual(["w1:p1", null]);
  expect(next.openTabs).toEqual(["w1:p1"]);
});

test("removing a tab outside the grid does not change the grid", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1"]);
  const next = removeTab(shown, "w1:p2");
  expect(next.slots).toEqual(["w1:p1"]);
  expect(next.current).toBe("w1:p1");
});

test("the successor decided when the confirm opened is kept", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", ["w1:p1"]);
  const next = removeTab(shown, "w1:p1", "w1:p3");
  expect(next.current).toBe("w1:p3");
  expect(next.slots).toEqual(["w1:p3"]);
});

test("a snapshot does not put a removed tab back", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const removed = removeTab(shown, "w1:p1");
  // 外したペインは Herdr 側に残る。実在するだけでタブへ戻してはいけない。
  expect(syncSplitView(removed, existsAmong(["w1:p1", "w1:p2"]))).toEqual(removed);
});

test("restoring the saved view does not put a removed tab back", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const removed = removeTab(shown, "w1:p2");
  expect(normalizeSplitView(removed, existsAmong(["w1:p1", "w1:p2"]))).toEqual(removed);
});

test("closing an empty slot compacts the grid", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", null, "w1:p2"]);
  const next = closeEmptySlot(shown, 1);
  expect(next.slots).toEqual(["w1:p1", "w1:p2"]);
  expect(next.current).toBe("w1:p1");
  // 埋まっているスロットは、空きとして閉じられない。
  expect(closeEmptySlot(shown, 0)).toBe(shown);
});

test("the add band appends a slot without changing the selection", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1"]);
  const next = addToSlots(shown, "w1:p2");
  expect(next.slots).toEqual(["w1:p1", "w1:p2"]);
  expect(next.current).toBe("w1:p1");
  // 4 枚を超えない。スロットに入っているペインは受け付けない。
  const full = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
  expect(addToSlots(full, "w1:p5").slots).toHaveLength(MAX_SLOTS);
  expect(addToSlots(shown, "w1:p1")).toBe(shown);
});

test("dropping a pane from another slot moves it into the empty slot", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", null, "w1:p2"]);
  const next = dropOnSlot(shown, "w1:p1", 1);
  expect(next.slots).toEqual([null, "w1:p1", "w1:p2"]);
  // ドラッグしたペインが current なら、移動先へ追従する。
  expect(next.current).toBe("w1:p1");
});

test("dropping a pane onto a filled slot swaps the two", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = dropOnSlot(shown, "w1:p1", 1);
  expect(next.slots).toEqual(["w1:p2", "w1:p1"]);
  expect(next.current).toBe("w1:p1");
});

test("dropping on the current slot makes the dropped pane current", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = dropOnSlot(shown, "w1:p2", 0);
  expect(next.slots).toEqual(["w1:p2", "w1:p1"]);
  expect(next.current).toBe("w1:p2");
});

test("dropping a tab outside the grid replaces the target slot", () => {
  const shown = view(["w1:p1", "w1:p2", "w1:p3"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = dropOnSlot(shown, "w1:p3", 1);
  expect(next.slots).toEqual(["w1:p1", "w1:p3"]);
  // 置き換えで外れたペインは履歴に残る。
  expect(next.openTabs).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
  // 落とし先が current のスロットでなければ、選択は動かない。
  expect(next.current).toBe("w1:p1");
});

test("dropping a pane on its own slot does nothing", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", "w1:p2"]);
  expect(dropOnSlot(shown, "w1:p1", 0)).toBe(shown);
  expect(dropOnSlot(shown, "w1:p1", 9)).toBe(shown);
});

test("a vanished pane leaves an empty slot and keeps the current id", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", ["w1:p1", "w1:p2"]);
  const next = syncSplitView(shown, existsAmong(["w1:p1"]));
  expect(next.openTabs).toEqual(["w1:p1"]);
  expect(next.slots).toEqual(["w1:p1", null]);
  // 選択は動かさない（ADR 0021）。id は戻ってきたときのために残す。
  expect(next.current).toBe("w1:p2");
});

test("a vanished pane that comes back is appended and placed in a slot", () => {
  const shown = view(["w1:p1"], "w1:p2", ["w1:p1", null]);
  const next = syncSplitView(shown, existsAmong(["w1:p1", "w1:p2"]));
  expect(next.openTabs).toEqual(["w1:p1", "w1:p2"]);
  expect(next.current).toBe("w1:p2");
  expect(next.slots).toEqual(["w1:p1", "w1:p2"]);
});

test("a current pane outside the grid is put back into a slot", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", ["w1:p1"]);
  expect(syncSplitView(shown, existsAmong(["w1:p1", "w1:p2"])).slots).toEqual(["w1:p1", "w1:p2"]);
});

test("a slot always fills the first empty one, then appends, then replaces slot 1", () => {
  expect(placeInSlots([null, "w1:p1"], "w1:p9")).toEqual(["w1:p9", "w1:p1"]);
  expect(placeInSlots(["w1:p1"], "w1:p9")).toEqual(["w1:p1", "w1:p9"]);
  expect(placeInSlots(["w1:p1", "w1:p2", "w1:p3", "w1:p4"], "w1:p9")).toEqual([
    "w1:p9",
    "w1:p2",
    "w1:p3",
    "w1:p4",
  ]);
});

test("the slot of the current pane is what the list and the tabs color", () => {
  const shown = view(["w1:p1", "w1:p2"], "w1:p2", ["w1:p1", null, "w1:p2"]);
  expect(currentSlotIndex(shown)).toBe(2);
  expect(slotIndexOf(shown, "w1:p1")).toBe(0);
  expect(slotIndexOf(shown, "w1:p9")).toBe(-1);
  expect(currentSlotIndex(view(["w1:p1"], null, ["w1:p1"]))).toBe(-1);
});

test("two spaces among the open tabs need the second line", () => {
  expect(multiSpace(["w1", "w1"])).toBe(false);
  expect(multiSpace(["w1", "w2"])).toBe(true);
  expect(multiSpace(NO_PANES)).toBe(false);
});

test("the saved view round-trips", () => {
  const shown = view(["w1:p1", "w2:p1"], "w2:p1", ["w1:p1", null, "w2:p1"]);
  expect(parseSplitView(serializeSplitView(shown))).toEqual(shown);
});

test("a broken value means an empty view", () => {
  expect(parseSplitView(null)).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("{")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView("[]")).toEqual(EMPTY_SPLIT_VIEW);
  expect(parseSplitView('{"openTabs":"w1:p1","current":3,"slots":{}}')).toEqual(EMPTY_SPLIT_VIEW);
});

test("restoring drops gone panes, duplicates and extra slots", () => {
  const stored = view(["w1:p1", "w9:p9", "w1:p1", "w1:p2"], "w1:p1", [
    "w1:p1",
    "w1:p1",
    "w9:p9",
    "w1:p2",
    "w1:p3",
  ]);
  const next = normalizeSplitView(stored, existsAmong(["w1:p1", "w1:p2", "w1:p3"]));
  expect(next.openTabs).toEqual(["w1:p1", "w1:p2"]);
  expect(next.slots).toEqual(["w1:p1", null, null, "w1:p2"]);
  expect(next.current).toBe("w1:p1");
});

test("restoring appends a slot that is not in the history", () => {
  const stored = view(["w1:p1"], "w1:p1", ["w1:p1", "w1:p2"]);
  const next = normalizeSplitView(stored, existsAmong(["w1:p1", "w1:p2"]));
  expect(next.openTabs).toEqual(["w1:p1", "w1:p2"]);
});

test("restoring puts a current pane back into the history and a slot", () => {
  const stored = view([], "w1:p2", []);
  const next = normalizeSplitView(stored, existsAmong(["w1:p1", "w1:p2"]));
  expect(next.openTabs).toEqual(["w1:p2"]);
  expect(next.slots).toEqual(["w1:p2"]);
  expect(next.current).toBe("w1:p2");

  const full = normalizeSplitView(
    view([], "w1:p9", ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]),
    existsAmong(["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p9"]),
  );
  expect(full.slots).toEqual(["w1:p9", "w1:p2", "w1:p3", "w1:p4"]);
});

test("restoring a gone current pane goes back to the list", () => {
  const next = normalizeSplitView(view(["w1:p1"], "w9:p9", ["w1:p1"]), existsAmong(["w1:p1"]));
  expect(next.current).toBeNull();
  expect(next.openTabs).toEqual(["w1:p1"]);
  expect(next.slots).toEqual(["w1:p1"]);
});

test("restoring keeps the positions of empty slots", () => {
  const next = normalizeSplitView(
    view(["w1:p1", "w1:p2"], "w1:p1", ["w1:p1", null, "w1:p2"]),
    existsAmong(["w1:p1", "w1:p2"]),
  );
  expect(next.slots).toEqual(["w1:p1", null, "w1:p2"]);
});
