import type { AppState } from "../server/herdr/state";
import { storage } from "./drafts";
import { findPane } from "./select";

// 開いていたペインは端末ごとの好み。Herdr の状態ではないので BFF には持たせない。
export const SELECTED_PANE_STORAGE_KEY = "hwc-selected-pane";

// 壊れた値や消えたペインは「まだ選んでいない」に倒す。開くはずのペインが無いだけで、
// 一覧から選び直せる。
export function parseSelectedPane(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

export function restorePane(state: AppState, stored: string | null): string | null {
  const paneId = parseSelectedPane(stored);
  if (paneId !== null && findPane(state, paneId)) return paneId;
  return defaultSelection(state);
}

// 最初に届いたスナップショットでは、Herdr が focus しているペインを開く。
export function defaultSelection(state: AppState): string | null {
  return findPane(state, state.focusedPaneId) ? state.focusedPaneId : null;
}

export function readSelectedPane(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return parseSelectedPane(store.getItem(SELECTED_PANE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeSelectedPane(paneId: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (paneId === null) store.removeItem(SELECTED_PANE_STORAGE_KEY);
    else store.setItem(SELECTED_PANE_STORAGE_KEY, paneId);
  } catch {
    // 保存できなくてもその場の表示は変える。
  }
}

// 開き直したペインが折りたたまれた中にあると、一覧のどこにいるのか分からない。
// そのペインのワークスペースとタブだけ開いておく。
export function expandForPane(
  state: AppState,
  paneId: string,
  open: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set(open);
  for (const workspace of state.workspaces) {
    const tab = workspace.tabs.find((candidate) =>
      candidate.panes.some((pane) => pane.id === paneId),
    );
    if (!tab) continue;
    next.add(workspace.id);
    next.add(tab.id);
    if (workspace.worktree) next.add(`repo:${workspace.worktree.repoName}`);
  }
  return next;
}
