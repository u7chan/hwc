import type {
  AgentStatus,
  AppState,
  PaneState,
  TabState,
  WorkspaceState,
} from "../server/herdr/state";

export type ListScope = "agent" | "active" | "all";

// ツリーで並べるスコープ。active は行の作り方が違うので、ここには含めない。
export type TreeScope = Exclude<ListScope, "active">;

export const LIST_SCOPE_STORAGE_KEY = "hwc-list-scope";

// 既定はエージェントのいるスペースだけ。シェルだけのスペースは、そこで
// エージェントを起こすときに「すべて」で探す。
export function parseListScope(raw: string | null): ListScope {
  switch (raw) {
    case "active":
      return "active";
    case "all":
      return "all";
    default:
      return "agent";
  }
}

export function workspaceHasAgent(workspace: WorkspaceState): boolean {
  return workspace.tabs.some((tab) => tab.panes.some((pane) => pane.agent !== null));
}

// 絞り込んでも、いま開いているスペースだけは残す。読んでいるものが消えるほうが困る。
export function scopeWorkspaces(
  workspaces: readonly WorkspaceState[],
  scope: TreeScope,
  selectedPaneId: string | null,
): readonly WorkspaceState[] {
  if (scope === "all") return workspaces;
  return workspaces.filter(
    (workspace) =>
      workspaceHasAgent(workspace) ||
      workspace.tabs.some((tab) => tab.panes.some((pane) => pane.id === selectedPaneId)),
  );
}

// 状態を持つエージェントだけを 1 行ずつ並べる。idle と unknown は出さない。
const ACTIVE_STATUSES = ["blocked", "working", "done"] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function isActiveStatus(status: AgentStatus): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly AgentStatus[]).includes(status);
}

export type ActivePane = {
  workspace: WorkspaceState;
  tab: TabState;
  pane: PaneState;
};

// 要対応 → 実行中 → 完了。同順位は state の並び（ワークスペース → タブ → ペイン）のまま。
// ツリーの絞り込みと違い、選択中のペインは残さない。idle を出さない以上、
// 開いているペインがこの一覧から消えるのが正しい。
export function activePanes(state: AppState): readonly ActivePane[] {
  const rows: ActivePane[] = [];
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agent === null || !isActiveStatus(pane.agentStatus)) continue;
        rows.push({ workspace, tab, pane });
      }
    }
  }
  return ACTIVE_STATUSES.flatMap((status) => rows.filter((row) => row.pane.agentStatus === status));
}

// 未読は「完了してまだ見ていない」数だけ。開くと seen が進んで消えるので、受信箱の件数になる。
// blocked を混ぜると意味が変わる（未読ではなく、止まっている）。
export function activeUnreadCount(state: AppState): number {
  return activePanes(state).filter((row) => row.pane.agentStatus === "done").length;
}

// 3 桁を超えたら数えても読めない。件数は目安で足りる。
export function unreadLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

// seen が進むのは done だけ。working / blocked で TUI のフォーカスを動かす理由は無い。
export function shouldFocusPane(scope: ListScope, status: AgentStatus): boolean {
  return scope === "active" && status === "done";
}
