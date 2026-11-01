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

// ペインを 1 枚だけ取り除く。空になったタブとワークスペースも一緒に落とす。
export function removePane(state: AppState, paneId: string): AppState {
  return {
    ...state,
    workspaces: state.workspaces
      .map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs
          .map((tab) => ({ ...tab, panes: tab.panes.filter((pane) => pane.id !== paneId) }))
          .filter((tab) => tab.panes.length > 0),
      }))
      .filter((workspace) => workspace.tabs.length > 0),
  };
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

export type AgentGlyph = "pi" | "claude" | "codex" | "opencode" | "generic";

// 一覧のアイコンを決める。opencode は "pi" を含まないが、順序に依存しないよう先に見る。
export function agentGlyph(agent: string | null): AgentGlyph {
  const name = (agent ?? "").toLowerCase();
  if (name.includes("opencode")) return "opencode";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  if (name.includes("codex") || name.includes("openai") || name.includes("gpt")) return "codex";
  if (
    name === "pi" ||
    name.startsWith("pi-") ||
    name.startsWith("pi ") ||
    name.includes("coding-agent")
  ) {
    return "pi";
  }
  return "generic";
}
