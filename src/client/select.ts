import type { AgentStatus, AppState, PaneState } from "../server/herdr/state";

export function findPane(state: AppState, paneId: string | null): PaneState | null {
  if (paneId === null) return null;
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.id === paneId) return pane;
      }
    }
  }
  return null;
}

export function countPanes(state: AppState): number {
  return state.workspaces.reduce(
    (total, workspace) =>
      total + workspace.tabs.reduce((tabTotal, tab) => tabTotal + tab.panes.length, 0),
    0,
  );
}

export function countWorkspacePanes(workspaceId: string, state: AppState): number {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return 0;
  return workspace.tabs.reduce((total, tab) => total + tab.panes.length, 0);
}

// 画面上部に出す、いま見ている対象の要約。選択が無いときは null。
export function findPaneContext(
  state: AppState,
  paneId: string | null,
): { workspaceLabel: string; tabLabel: string } | null {
  if (paneId === null) return null;
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.panes.some((pane) => pane.id === paneId)) {
        return { workspaceLabel: workspace.label, tabLabel: tab.label };
      }
    }
  }
  return null;
}

export type StatusTone = "active" | "attention" | "success" | "neutral";

export function statusTone(status: AgentStatus): StatusTone {
  switch (status) {
    case "working":
      return "active";
    case "blocked":
      return "attention";
    case "done":
      return "success";
    default:
      return "neutral";
  }
}

export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "working":
      return "実行中";
    case "blocked":
      return "要対応";
    case "done":
      return "完了";
    case "idle":
      return "待機";
    default:
      return "不明";
  }
}

// フォーカス中の workspace だけを開いた状態で始める。
export function initialExpanded(state: AppState): Set<string> {
  return new Set(
    state.workspaces.filter((workspace) => workspace.focused).map((workspace) => workspace.id),
  );
}
