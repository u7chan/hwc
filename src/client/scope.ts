import type { AgentStatus, AppState, WorkspaceState } from "../server/herdr/state";
import type { PaneRow } from "./select";
import { sentPanes, type SentPane } from "./sent";

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

export function scopeWorkspaces(
  workspaces: readonly WorkspaceState[],
  scope: TreeScope,
): readonly WorkspaceState[] {
  if (scope === "all") return workspaces;
  return workspaces.filter(workspaceHasAgent);
}

// 状態を持つエージェントだけを 1 行ずつ並べる。idle と unknown は出さない。
const ACTIVE_STATUSES = ["blocked", "working", "done"] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function isActiveStatus(status: AgentStatus): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly AgentStatus[]).includes(status);
}

export type ActivePane = PaneRow;

// 要対応 → 実行中 → 完了。同順位は state の並び（ワークスペース → タブ → ペイン）のまま。
// 選択中のペインでも、idle なら一覧から消える。
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

// 表示の並びは要対応 → 窓口 → 完了 → 実行中。上から「自分が動く番 → 読む番 →
// 待つ番」に揃える。窓口は状態の行と重なるので、先に置いた側だけを残す。
export function activeViewRows(
  state: AppState,
  sent: ReadonlyMap<string, SentPane>,
): readonly PaneRow[] {
  const windows = sentPanes(state, sent);
  const inWindow = new Set(windows.map((row) => row.pane.id));
  const rows = activePanes(state);
  const blocked = rows.filter((row) => row.pane.agentStatus === "blocked");
  const done = rows.filter((row) => row.pane.agentStatus === "done" && !inWindow.has(row.pane.id));
  const working = rows.filter(
    (row) => row.pane.agentStatus === "working" && !inWindow.has(row.pane.id),
  );
  return [...blocked, ...windows, ...done, ...working];
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
