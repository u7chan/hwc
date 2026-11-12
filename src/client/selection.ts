import type { AppState, PaneState, TabState, WorkspaceState } from "../server/herdr/state";
import { storage } from "./drafts";
import { placeGroupKeyFor } from "./select";
import { type SplitView, parseSplitView, serializeSplitView } from "./split-view";

// 開いていたタブ・選択・分割の木は端末ごとの好み。Herdr の状態ではないので BFF には
// 持たせない。キーは 1 つにまとめる
// （ADR 0058 / 0061 / 0063 tab-order-by-pane-layout）。
export const SPLIT_VIEW_STORAGE_KEY = "hwc-split-view";

// 未保存なら null。壊れた値は空として返し、初回表示の初期値で上書きしない。
export function readSplitView(): SplitView | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(SPLIT_VIEW_STORAGE_KEY);
    return value === null ? null : parseSplitView(value);
  } catch {
    return null;
  }
}

export function writeSplitView(view: SplitView): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SPLIT_VIEW_STORAGE_KEY, serializeSplitView(view));
  } catch {
    // 保存だけ諦める。
  }
}

export type WorkspacePane = { tab: TabState; pane: PaneState };

// スペースの代表ペイン。先頭タブ（左端）の先頭ペインを既定にする。空のタブは飛ばす。
export function defaultPaneOf(workspace: WorkspaceState): WorkspacePane | null {
  const tab = workspace.tabs.find((candidate) => candidate.panes.length > 0);
  const pane = tab?.panes[0];
  return tab !== undefined && pane !== undefined ? { tab, pane } : null;
}

// ツリーでそのスペースを見せるために開く単位。代表タブと、同じリポジトリの束、
// 同じ場所の束も含める。
export function workspaceGroupIds(state: AppState, workspace: WorkspaceState): string[] {
  const target = defaultPaneOf(workspace);
  const groups = [workspace.id];
  if (target !== null) groups.push(target.tab.id);
  if (workspace.worktree !== null) groups.push(`repo:${workspace.worktree.repoName}`);
  const place = placeGroupKeyFor(state.workspaces, workspace.id);
  if (place !== null) groups.push(place);
  return groups;
}

// 帯からの移動は「いまこの場所を見たい」という指示。自分で畳んでいた記憶より優先して開く。
export function expandForWorkspace(
  state: AppState,
  workspaceId: string,
  open: ReadonlySet<string>,
): Set<string> | null {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) return null;
  const next = new Set(open);
  for (const groupId of workspaceGroupIds(state, workspace)) next.add(groupId);
  return next;
}

function paneLocation(
  state: AppState,
  paneId: string,
): { workspace: WorkspaceState; tab: TabState } | null {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.panes.some((pane) => pane.id === paneId)) return { workspace, tab };
    }
  }
  return null;
}

// タブ・セル・一覧からペインを選んだときに開く単位。畳んでいた記憶は見ない。選んだ
// ペインが一覧のどこにいるか分からないと、また同じペインを探すことになる。
export function revealPane(
  state: AppState,
  paneId: string,
  open: ReadonlySet<string>,
): Set<string> {
  const next = new Set(open);
  const location = paneLocation(state, paneId);
  if (location === null) return next;
  next.add(location.workspace.id);
  next.add(location.tab.id);
  if (location.workspace.worktree !== null)
    next.add(`repo:${location.workspace.worktree.repoName}`);
  const place = placeGroupKeyFor(state.workspaces, location.workspace.id);
  if (place !== null) next.add(place);
  return next;
}

// 明示的な移動で開いた単位は、次に開いたときも開いておく。
export function revealPaneGroups(state: AppState, paneId: string): string[] {
  const location = paneLocation(state, paneId);
  if (location === null) return [];
  const groups = [location.workspace.id, location.tab.id];
  if (location.workspace.worktree !== null)
    groups.push(`repo:${location.workspace.worktree.repoName}`);
  const place = placeGroupKeyFor(state.workspaces, location.workspace.id);
  if (place !== null) groups.push(place);
  return groups;
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
    const place = placeGroupKeyFor(state.workspaces, workspace.id);
    if (place !== null && !shut(place)) next.add(place);
  }
  return next;
}
