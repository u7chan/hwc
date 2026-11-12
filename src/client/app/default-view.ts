import type { AppState } from "../../server/herdr/state";
import { applyOpenGroups } from "../expanded";
import { findPane, groupIds, initialExpanded } from "../select";
import { expandForPane, readSplitView } from "../selection";
import { normalizeSplitView, startSplitView } from "../split-view";
import type { View } from "./types";

// 開き方の初期値は最初のスナップショットで決めて、以後の focus 移動には追従しない。
// 読んでいる途中で勝手に別のペインへ切り替わらないようにするため。
// 前回開いていたペインが残っていればそこへ戻す（再読み込みや HMR で先頭へ飛ばない）。
export function defaultView(
  state: AppState,
  openGroups: ReadonlyMap<string, boolean> | null,
): View {
  const stored = readSplitView();
  const split =
    stored === null
      ? startSplitView(findPane(state, state.focusedPaneId) === null ? null : state.focusedPaneId)
      : normalizeSplitView(stored, (paneId) => findPane(state, paneId) !== null);
  const remembered = openGroups ?? new Map();
  const base = applyOpenGroups(initialExpanded(state), remembered, groupIds(state));
  return {
    split,
    expanded: split.current === null ? base : expandForPane(state, split.current, base, remembered),
  };
}
