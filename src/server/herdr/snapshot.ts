import type { AgentStatus } from "./contract";
import type { GitSync } from "../../shared/git";

// スナップショットの形だけを持つ。pane-times は時刻を突き合わせるのにこの形を要るが、
// 取得と保存を担う state.ts に依存させると循環になる。公開している型は state.ts が
// そのまま再 export する。

export type PaneState = {
  id: string;
  title: string | null;
  label: string | null;
  agent: string | null;
  agentStatus: AgentStatus;
  focused: boolean;
  chat: boolean;
};

export type TabState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  panes: PaneState[];
};

export type WorktreeState = {
  repoName: string;
  repoRoot: string | null;
  checkoutPath: string | null;
  isLinkedWorktree: boolean;
  // Herdr がワークツリーとして登録しているか。作成・削除は登録済みのスペースでしか行えない。
  managed: boolean;
};

export type WorkspaceState = {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  focused: boolean;
  worktree: WorktreeState | null;
  // スペースの作業ディレクトリ。Herdr が worktree を返さないスペースでは先頭ペインの
  // cwd に落とす。worktree.checkoutPath は非 git スペースで null になるため、表示と
  // コピーにはこちらを使う。
  path?: string | null;
  // ブランチは Herdr の snapshot に無いので、BFF が checkoutPath から読んで足す。
  branch?: string | null;
  // 上流ブランチとの差。リモートが無い・読めない場合は null。
  sync?: GitSync | null;
  tabs: TabState[];
};

export type SnapshotState = {
  focusedWorkspaceId: string | null;
  focusedTabId: string | null;
  focusedPaneId: string | null;
  workspaces: WorkspaceState[];
};
