import type { AppState } from "../server/herdr/state";
import { storage } from "./drafts";
import { findPane } from "./select";

// 開いていたペインは端末ごとの好み。Herdr の状態ではないので BFF には持たせない。
export const SELECTED_PANE_STORAGE_KEY = "hwc-selected-pane";

// 一覧に戻したかどうかは、ペイン id だけでは表せない（未選択と未訪問が同じになる）。
// スマホでは一覧と詳細が別の画面なので、再読み込みで読んでいた画面に戻すために要る。
export const LIST_OPEN_STORAGE_KEY = "hwc-list-open";

// 壊れた値や消えたペインは「まだ選んでいない」に倒す。開くはずのペインが無いだけで、
// 一覧から選び直せる。
export function parseSelectedPane(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

export function restorePane(
  state: AppState,
  stored: string | null,
  listOpen = false,
): string | null {
  // 一覧に戻していたなら、その画面へ戻す。ペインを開いていたときだけ復元する。
  if (listOpen) return null;
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

export function readListOpen(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(LIST_OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeListOpen(open: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    if (open) store.setItem(LIST_OPEN_STORAGE_KEY, "true");
    else store.removeItem(LIST_OPEN_STORAGE_KEY);
  } catch {
    // 保存できなくてもその場の表示は変える。
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
// そのペインのワークスペースとタブだけ開いておく。ただし利用者が自分で畳んだものは
// 開き直さない（覚えている開閉と画面を食い違わせない）。
export function expandForPane(
  state: AppState,
  paneId: string,
  open: ReadonlySet<string>,
  remembered: ReadonlyMap<string, boolean>,
): ReadonlySet<string> {
  const next = new Set(open);
  const shut = (groupId: string) => remembered.get(groupId) === false;
  for (const workspace of state.workspaces) {
    const tab = workspace.tabs.find((candidate) =>
      candidate.panes.some((pane) => pane.id === paneId),
    );
    if (!tab) continue;
    if (!shut(workspace.id)) next.add(workspace.id);
    if (!shut(tab.id)) next.add(tab.id);
    const repo = workspace.worktree ? `repo:${workspace.worktree.repoName}` : null;
    if (repo !== null && !shut(repo)) next.add(repo);
  }
  return next;
}
