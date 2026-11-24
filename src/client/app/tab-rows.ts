import type { AppState } from "../../server/herdr/state";
import { findPaneRow, type PaneRow } from "../select";
import { multiSpace } from "../split-view";

// セルのタブ列に出す行と、タブ名にスペース名を前置きするか。葉の tabs はペイン id だけを
// 並びの正として持つので、表示に要る行はここで引く。
export type TabRows = {
  rows: PaneRow[];
  multiSpace: boolean;
};

const NO_TABS: TabRows = { rows: [], multiSpace: false };

// 消えたペインは行に出さない。並びは葉の tabs のまま。
export function tabRows(state: AppState, paneIds: readonly string[]): TabRows {
  const rows = paneIds.flatMap((paneId) => {
    const row = findPaneRow(state, paneId);
    return row === null ? [] : [row];
  });
  if (rows.length === 0) return NO_TABS;
  return { rows, multiSpace: multiSpace(rows.map((row) => row.workspace.id)) };
}
