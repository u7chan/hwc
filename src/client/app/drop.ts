import { canDrop, canSwapTabs, type DropZone, type SplitView } from "../split-view";
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
  // 固定ゾーンのタブはセルの中央と同じ入れ替えを受け付ける（ADR 0064）。
  // プレビュー中は TabBar が data-drop-tab を出さないので、ここへは来ない。
  const tab = element?.closest("[data-drop-tab]");
  if (!(tab instanceof HTMLElement)) return null;
  const pane = tab.dataset.dropTab;
  if (pane === undefined) return null;
  return canSwapTabs(view, source, pane, wide) ? { kind: "tab", pane, zone: "center" } : null;
}
