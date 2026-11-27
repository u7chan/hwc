import { expect, test } from "bun:test";
import {
  type AppState,
  NO_TIMES,
  type PaneState,
  type TabState,
  type WorktreeState,
  type WorkspaceState,
} from "../../server/herdr/state";
import type { PullRequest } from "../../shared/pull-request";
import { menuView, type MenuViewInput } from "./menu";
import type { GitAction, OperationMenu } from "./types";

const pane = (id: string): PaneState => ({
  id,
  title: null,
  label: null,
  agent: null,
  agentStatus: "idle",
  focused: false,
  chat: false,
});

const tab = (id: string, paneIds: string[], label = id): TabState => ({
  id,
  label,
  agentStatus: "idle",
  focused: false,
  panes: paneIds.map(pane),
});

const worktree = (linked: boolean): WorktreeState => ({
  repoName: "hwc",
  repoRoot: "/home/example/hwc",
  checkoutPath: linked ? "/home/example/hwc-wt" : "/home/example/hwc",
  isLinkedWorktree: linked,
  managed: true,
});

const workspace = (
  id: string,
  tabs: TabState[],
  overrides: Partial<WorkspaceState> = {},
): WorkspaceState => ({
  id,
  label: id,
  agentStatus: "idle",
  focused: false,
  worktree: null,
  path: `/home/example/${id}`,
  branch: null,
  sync: null,
  tabs,
  ...overrides,
});

// 本体（ホスト）と linked worktree の 2 スペース。並びの先頭は hwc 本体。
const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  times: NO_TIMES,
  workspaces: [
    workspace("w1", [tab("w1:t1", ["w1:p1", "w1:p2"])], {
      worktree: worktree(false),
      branch: "main",
      sync: {
        upstream: "origin/main",
        upstreamBranch: "main",
        ahead: 0,
        behind: 0,
        hasRemote: true,
        repoUrl: "https://github.com/example/hwc",
      },
    }),
    workspace("w2", [tab("w2:t1", ["w2:p1"])], { worktree: worktree(true) }),
    // 並びの束はリポジトリごと。別のリポジトリのスペースは 2 番目の束になる。
    workspace("w3", [tab("w3:t1", ["w3:p1"])], {
      worktree: { ...worktree(false), repoName: "other" },
    }),
  ],
};

const PR: PullRequest = {
  number: 12,
  url: "https://github.com/example/hwc/pull/12",
  title: "Fix things",
  state: "OPEN",
  headRefOid: "0123456789abcdef0123456789abcdef01234567",
};

const paneMenu = (id: string): OperationMenu => ({
  target: { kind: "pane", id },
  trigger: null as unknown as HTMLElement,
  fromList: false,
  open: true,
});

const workspaceMenu = (id: string): OperationMenu => ({
  target: { kind: "workspace", id },
  trigger: null as unknown as HTMLElement,
  fromList: true,
  open: true,
});

const input = (overrides: Partial<MenuViewInput> = {}): MenuViewInput => ({
  state,
  menu: paneMenu("w1:p1"),
  pullRequests: new Map([["w1", PR]]),
  gitAction: null,
  ...overrides,
});

// メニューを開いていなければ、スナップショットがあっても中身は空。
test("a closed menu derives nothing", () => {
  expect(menuView(input({ menu: null })).pane).toBeNull();
  expect(menuView(input({ state: null })).workspace).toBeNull();
});

// ペインのメニューは、対象の行とタブと閉じ方だけを引く。スペースの項目は出さない。
test("a pane menu carries the row it was opened for", () => {
  const view = menuView(input());
  expect(view.paneId).toBe("w1:p1");
  expect(view.row?.tab.id).toBe("w1:t1");
  expect(view.full).toBe(false);
  expect(view.closeAction).toBe("close");
  expect(view.workspace).toBeNull();
  expect(view.canCreateWorktree).toBe(false);
});

// 4 ペインで埋まったタブでは、新しいペインの項目を押せなくする。
test("a pane menu reports a full tab", () => {
  const full: AppState = {
    ...state,
    workspaces: [
      workspace("w1", [tab("w1:t1", ["w1:p1", "w1:p2", "w1:p3", "w1:p4"])], {
        worktree: worktree(false),
      }),
    ],
  };
  expect(menuView(input({ state: full })).full).toBe(true);
});

// スペースのメニューは、PR・リポジトリ・git の実行状態を対象のスペースから引く。
test("a workspace menu reads the pull request and the git action", () => {
  const view = menuView(
    input({
      menu: workspaceMenu("w1"),
      gitAction: { workspaceId: "w1", action: "fetch", phase: "busy" },
    }),
  );
  expect(view.paneId).toBeNull();
  expect(view.workspace?.id).toBe("w1");
  expect(view.pullRequest).toEqual(PR);
  expect(view.repoUrl).toBe("https://github.com/example/hwc");
  expect(view.gitBusy).toBe("fetch");
  expect(view.gitFailed).toBeNull();
  expect(view.canCreateWorktree).toBe(true);
  expect(view.canCloseSpace).toBe(true);
  expect(view.canMoveToTop).toBe(false);
});

// 実行が失敗していれば、その操作と理由を出す。別のスペースの実行は見せない。
test("a failed git action shows only for the workspace it ran on", () => {
  const failed: GitAction = {
    workspaceId: "w1",
    action: "pull",
    phase: "failed",
    error: "no_remote",
  };
  const view = menuView(input({ menu: workspaceMenu("w1"), gitAction: failed }));
  expect(view.gitBusy).toBeNull();
  expect(view.gitFailed).toEqual({ action: "pull", error: "no_remote" });
  expect(menuView(input({ menu: workspaceMenu("w2"), gitAction: failed })).gitFailed).toBeNull();
});

// linked worktree は Herdr が作ったものだけ削除でき、閉じる項目は出さない。
// 並びの束はリポジトリごとなので、本体と同じ束にいる間は先頭への移動も出さない。
test("a linked worktree can be removed instead of closed", () => {
  const view = menuView(input({ menu: workspaceMenu("w2") }));
  expect(view.canCreateWorktree).toBe(false);
  expect(view.canCloseSpace).toBe(false);
  expect(view.canMoveToTop).toBe(false);
});

// 先頭でない束のスペースには、先頭へ移動の項目を出す。
test("a workspace outside the first group can be moved to the top", () => {
  expect(menuView(input({ menu: workspaceMenu("w3") })).canMoveToTop).toBe(true);
});

// スペースが 1 つだけなら閉じる項目は出さない。0 スペースにはしない。
test("the last workspace cannot be closed from the menu", () => {
  const only: AppState = { ...state, workspaces: state.workspaces.slice(0, 1) };
  expect(menuView(input({ state: only, menu: workspaceMenu("w1") })).canCloseSpace).toBe(false);
});
