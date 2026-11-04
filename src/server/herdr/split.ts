import { MAX_PANES_PER_TAB } from "../../shared/panes";
import type { PaneLayoutCell } from "./contract";

export type SplitDirection = "right" | "down";

export type SplitPlan = {
  paneId: string;
  direction: SplitDirection;
  ratio: number;
};

// 文字セルの高さに対する幅の比。Herdr の pane-layout と同じ近似。
const CELL_RATIO = 0.48;
// 分割後のセルをこの縦横比へ寄せる。狭すぎるセルと横長すぎるセルのどちらも避ける。
const TARGET_ASPECT = 1.4;

function aspect(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0;
  return (width * CELL_RATIO) / height;
}

function distanceToTarget(width: number, height: number): number {
  const value = aspect(width, height);
  return value > 0 ? Math.abs(Math.log(value / TARGET_ASPECT)) : Number.POSITIVE_INFINITY;
}

// 追加 1 回につき 1 枚だけ増やす。最大面積のセルを半分に割ると、1→2、3 は L 字、
// 4 で 2x2 に揃う。既存の並びは変えず、上限に達したタブでは作らない。
export function planSplit(cells: readonly PaneLayoutCell[]): SplitPlan | null {
  if (cells.length === 0 || cells.length >= MAX_PANES_PER_TAB) return null;

  let target = cells[0]!;
  for (const cell of cells) {
    if (cell.width * cell.height > target.width * target.height) target = cell;
  }

  const right = distanceToTarget(target.width / 2, target.height);
  const down = distanceToTarget(target.width, target.height / 2);
  return {
    paneId: target.paneId,
    direction: right <= down ? "right" : "down",
    ratio: 0.5,
  };
}
