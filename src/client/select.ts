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

// ペインを別のタブへ移す。同じタブの中なら並び順の入れ替えになる。
export function movePane(
  state: AppState,
  paneId: string,
  targetTabId: string,
  targetIndex: number,
): AppState {
  let moved: PaneState | null = null;
  let sourceTabId: string | null = null;
  let sourceIndex = -1;

  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      const index = tab.panes.findIndex((pane) => pane.id === paneId);
      if (index === -1) continue;
      moved = tab.panes[index];
      sourceTabId = tab.id;
      sourceIndex = index;
    }
  }
  if (!moved || !sourceTabId) return state;

  // 同じタブの中で後ろへ動かすときは、自分が抜けた分だけ前へ詰まる。
  const sameTab = sourceTabId === targetTabId;
  const insertAt = sameTab && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const pane = moved;
  let changed = false;

  const workspaces = state.workspaces.map((workspace) => ({
    ...workspace,
    tabs: workspace.tabs.map((tab) => {
      const without = tab.panes.filter((item) => item.id !== paneId);
      if (tab.id !== targetTabId) {
        if (without.length === tab.panes.length) return tab;
        changed = true;
        return { ...tab, panes: without };
      }
      const next = [...without];
      next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, pane);
      changed = true;
      return { ...tab, panes: next };
    }),
  }));

  return changed ? { ...state, workspaces } : state;
}

// 一覧に並ぶ順（ワークスペース内のタブを横断した順）で、前後のペインへ 1 つ動かす。
export function movePaneStep(state: AppState, paneId: string, delta: -1 | 1): AppState {
  for (const workspace of state.workspaces) {
    const flat = workspace.tabs.flatMap((tab) =>
      tab.panes.map((pane, index) => ({ pane, tabId: tab.id, index })),
    );
    const at = flat.findIndex((item) => item.pane.id === paneId);
    if (at === -1) continue;
    const target = flat[at + delta];
    if (!target) return state;
    return movePane(state, paneId, target.tabId, target.index + (delta > 0 ? 1 : 0));
  }
  return state;
}

export function canMovePane(state: AppState, paneId: string, delta: -1 | 1): boolean {
  return movePaneStep(state, paneId, delta) !== state;
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
