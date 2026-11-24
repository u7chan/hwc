import { canDrop, leafOfPane, type DropZone, type SplitView } from "../split-view";
import type { DropTarget } from "./types";

// ポインタがセルのどこにあるか。親の分割軸と直交する向きだけを返す。
export function dropZoneAt(cell: HTMLElement, x: number, y: number): DropZone {
  const rect = cell.getBoundingClientRect();
  const u = (x - rect.left) / rect.width;
  const v = (y - rect.top) / rect.height;
  const parent = cell.dataset.dropParent;
  if (parent === "row") return v < 0.32 ? "top" : v > 0.68 ? "bottom" : "center";
  if (parent === "col") return u < 0.32 ? "left" : u > 0.68 ? "right" : "center";
  // 親が無い単独セルは 4 方向。最も近い辺を選ぶ。
  const edges: readonly (readonly [DropZone, number])[] = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const nearest = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return nearest[1] < 0.3 ? nearest[0] : "center";
}

// タブとタブ列はセルの中にあるので、セルより先に見る。セルとして拾ってしまうと、
// タブの上で端の分割プレビューが出る。
export function dropTargetAt(
  x: number,
  y: number,
  source: string,
  view: SplitView,
): DropTarget | null {
  // ビューポートの外では何も返らない。掴んだまま画面外で離しただけで分割しない。
  const element = document.elementFromPoint(x, y);

  const tab = element?.closest("[data-drop-tab]");
  if (tab instanceof HTMLElement) {
    const pane = tab.dataset.dropTab;
    if (pane === undefined || pane === source) return null;
    if (leafOfPane(view.layout, pane) === null) return null;
    const rect = tab.getBoundingClientRect();
    return {
      kind: "tab",
      pane,
      side: x < rect.left + rect.width / 2 ? "before" : "after",
      gap: false,
    };
  }

  // タブ列の隙間と余白。同じ葉なら並べ替え、別の葉ならその位置へ移す。
  const list = element?.closest("[data-drop-list]");
  if (list instanceof HTMLElement) {
    const leafPane = list.dataset.dropLeaf;
    if (leafPane === undefined || leafOfPane(view.layout, leafPane) === null) return null;
    const tabs = [...list.querySelectorAll<HTMLElement>("[data-drop-tab]")];
    const before = tabs.find((item) => {
      const rect = item.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    const target = before ?? tabs[tabs.length - 1];
    const pane = target?.dataset.tabPane;
    if (pane === undefined || pane === source) return null;
    return { kind: "tab", pane, side: before === undefined ? "after" : "before", gap: true };
  }

  const cell = element?.closest("[data-drop-pane]");
  if (cell instanceof HTMLElement) {
    const pane = cell.dataset.dropPane;
    if (pane === undefined) return null;
    const zone = dropZoneAt(cell, x, y);
    return canDrop(view, source, pane, zone) ? { kind: "cell", pane, zone } : null;
  }
  return null;
}
