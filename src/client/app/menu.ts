import type { AppState, PaneState, WorkspaceState } from "../../server/herdr/state";
import { MAX_PANES_PER_TAB } from "../../shared/panes";
import { paneCloseAction } from "../../shared/pane-close";
import type { PullRequest } from "../../shared/pull-request";
import { moveToTopPlan, orderUnits } from "../order";
import type { GitSyncFailure } from "../requests/workspaces";
import { canCloseSpace, findPaneRow, groupWorkspaces, type PaneRow } from "../select";
import type { GitAction, OperationMenu } from "./types";

// 開いているメニューの中身。対象はメニューを開いた時点の id だけを持ち、表示に要る値は
// そのつどスナップショットから引く。閉じたペイン・消えたスペースの項目は出さない。
export type MenuView = {
  // ペインのメニューなら対象の id。スペースのメニューでは null。
  paneId: string | null;
  row: PaneRow | null;
  pane: PaneState | null;
  // 対象のタブが 4 ペインで埋まっているか。BFF と同じタブの枚数で判定する。
  full: boolean;
  closeAction: ReturnType<typeof paneCloseAction>;
  workspace: WorkspaceState | null;
  pullRequest: PullRequest | null;
  repoUrl: string | null;
  gitBusy: "fetch" | "pull" | null;
  gitFailed: { action: "fetch" | "pull"; error: GitSyncFailure } | null;
  // worktree.create で開くスペースだけを例外にする。一般のスペース作成はメニューに無い。
  canCreateWorktree: boolean;
  canCloseSpace: boolean;
  // 並びの正は Herdr。メニューはその移動を 1 タップで呼ぶだけで、hwc 側に順序は持たない。
  // 既に先頭の束には項目を出さない。
  canMoveToTop: boolean;
};

export type MenuViewInput = {
  state: AppState | null;
  menu: OperationMenu | null;
  pullRequests: ReadonlyMap<string, PullRequest | null>;
  gitAction: GitAction | null;
};

const NO_MENU: MenuView = {
  paneId: null,
  row: null,
  pane: null,
  full: false,
  closeAction: null,
  workspace: null,
  pullRequest: null,
  repoUrl: null,
  gitBusy: null,
  gitFailed: null,
  canCreateWorktree: false,
  canCloseSpace: false,
  canMoveToTop: false,
};

export function menuView(input: MenuViewInput): MenuView {
  const { state, menu, pullRequests, gitAction } = input;
  if (state === null || menu === null) return NO_MENU;
  const paneId = menu.target.kind === "pane" ? menu.target.id : null;
  const row = findPaneRow(state, paneId);
  const workspace =
    menu.target.kind === "workspace"
      ? (state.workspaces.find((item) => item.id === menu.target.id) ?? null)
      : null;
  const worktree = workspace?.worktree ?? null;
  // 保存はメニューを閉じても続く。開いているメニューの対象と同じときだけ出す。
  const git =
    workspace !== null && gitAction !== null && gitAction.workspaceId === workspace.id
      ? gitAction
      : null;
  return {
    paneId,
    row,
    pane: row?.pane ?? null,
    full: row !== null && row.tab.panes.length >= MAX_PANES_PER_TAB,
    closeAction: paneId === null ? null : paneCloseAction(state, paneId),
    workspace,
    pullRequest: workspace === null ? null : (pullRequests.get(workspace.id) ?? null),
    repoUrl: workspace?.sync?.repoUrl ?? null,
    gitBusy: git?.phase === "busy" ? git.action : null,
    gitFailed: git?.phase === "failed" ? { action: git.action, error: git.error } : null,
    canCreateWorktree: worktree !== null && !worktree.isLinkedWorktree,
    canCloseSpace: workspace !== null && canCloseSpace(state, workspace.id),
    canMoveToTop:
      workspace !== null &&
      moveToTopPlan(
        orderUnits(groupWorkspaces(state.workspaces), state.workspaces),
        workspace.id,
      ) !== null,
  };
}
