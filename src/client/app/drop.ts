import { canDrop, tabDropMode, type DropZone, type SplitView } from "../split-view";
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

export function dropTargetAt(
  x: number,
  y: number,
  source: string,
  view: SplitView,
  wide: boolean,
): DropTarget | null {
  // ビューポートの外では何も返らない。掴んだまま画面外で離しただけで分割しない。
  const element = document.elementFromPoint(x, y);
  const cell = element?.closest("[data-drop-pane]");
  if (cell instanceof HTMLElement) {
    const pane = cell.dataset.dropPane;
    if (pane === undefined) return null;
    const zone = dropZoneAt(cell, x, y);
    return canDrop(view, source, pane, zone, wide) ? { kind: "cell", pane, zone } : null;
  }
  // タブは、分割では固定ゾーンの入れ替え、1 枚表示では差し込みを受け付ける
  // （ADR 0064 / 0086）。プレビュー中は TabBar が data-drop-tab を出さないので、
  // ここへは来ない。
  const tab = element?.closest("[data-drop-tab]");
  if (tab instanceof HTMLElement) {
    const pane = tab.dataset.dropTab;
    if (pane === undefined || tabDropMode(view, source, pane, wide) === null) return null;
    const rect = tab.getBoundingClientRect();
    return { kind: "tab", pane, side: x < rect.left + rect.width / 2 ? "before" : "after" };
  }
  // タブの隙間と列の余白も差し込みの落とし先にする。1 枚表示でだけ意味がある。
  // 分割では入れ替えなので、タブの外は受け付けない。
  const list = element?.closest("[data-tab-list]");
  if (!(list instanceof HTMLElement)) return null;
  const tabs = [...list.querySelectorAll<HTMLElement>("[data-tab-pane]")];
  // 左端がポインタより右にある最初のタブ。その前に入れる。余白と右端は末尾の後ろ。
  const before = tabs.find((tab) => {
    const rect = tab.getBoundingClientRect();
    return x < rect.left + rect.width / 2;
  });
  const target = before ?? tabs[tabs.length - 1];
  const pane = target?.dataset.tabPane;
  if (pane === undefined || tabDropMode(view, source, pane, wide) !== "insert") return null;
  return { kind: "tab", pane, side: before === undefined ? "after" : "before" };
}
