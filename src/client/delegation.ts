import type { AppState, PaneState, TabState } from "../server/herdr/state";
import { insertDelegatedPane, leafPanes, type SplitView } from "./split-view";

// 委譲そのものは Herdr のイベントに無い。代わりに、直前のスナップショットに無かった
// エージェントのペインを「委譲で現れたペイン」として扱う（ADR 0111）。
// シェルは数えない。委譲のプロンプトはエージェントが起動してから届く。

export function allPaneIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) ids.add(pane.id);
    }
  }
  return ids;
}

export function allAgentPaneIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agent !== null) ids.add(pane.id);
      }
    }
  }
  return ids;
}

export function tabOfPane(state: AppState, paneId: string): TabState | null {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.panes.some((pane) => pane.id === paneId)) return tab;
    }
  }
  return null;
}

export function newAgentPanes(state: AppState, seen: ReadonlySet<string>): PaneState[] {
  const panes: PaneState[] = [];
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agent !== null && !seen.has(pane.id)) panes.push(pane);
      }
    }
  }
  return panes;
}

export type DelegationResult = { split: SplitView; entering: string | null };

// 新しいペインを、いま画面に出ているセルと同じタブに限って差し込む。別のタブで
// 起動したペインまで並べると、見ていない場所の作業で画面が動いてしまう。
// entering は分割で入った最後のペイン。動きの対象を 1 枚に絞る。
export function applyDelegation(
  state: AppState,
  split: SplitView,
  panes: readonly PaneState[],
): DelegationResult | null {
  let next = split;
  let entering: string | null = null;
  for (const pane of panes) {
    const tab = tabOfPane(state, pane.id);
    if (tab === null) continue;
    const visible = leafPanes(next.layout);
    const sameTab = visible.some((paneId) => tab.panes.some((item) => item.id === paneId));
    if (!sameTab) continue;
    const updated = insertDelegatedPane(next, pane.id);
    if (updated === next) continue;
    const leaves = leafPanes(updated.layout);
    if (leaves.length > visible.length && leaves.includes(pane.id)) entering = pane.id;
    next = updated;
  }
  return next === split ? null : { split: next, entering };
}
