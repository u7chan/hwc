import type { AgentStatus, AppState, WorkspaceState } from "../server/herdr/state";
import type { PaneRow } from "./select";
import { sentPanes, type SentPane } from "./sent";

export type ListScope = "active" | "all";

export const LIST_SCOPE_STORAGE_KEY = "hwc-list-scope";

// 既定はすべて。片付けたいスペースが既定で隠れると、消す入口（ADR 0034）に辿り着けない。
// 絞り込みは active が担う。旧値の agent などは既定へ倒す。
export function parseListScope(raw: string | null): ListScope {
  return raw === "active" ? "active" : "all";
}

// 状態を持つエージェントだけを 1 行ずつ並べる。idle と unknown は出さない。
const ACTIVE_STATUSES = ["blocked", "working", "done"] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

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

// 束の中の順位。上から「自分が動く番 → 窓口 → 読む番 → 待つ番」に揃える。
// 窓口は状態に関わらず 1 か所にまとめ、状態の側からは除く。blocked の窓口は sentPanes が
// 返さないので、要対応の行としてだけ出る。
const RANK_BLOCKED = 0;
const RANK_WINDOW = 1;
const RANK_DONE = 2;
const RANK_WORKING = 3;

export type ActiveGroup = {
  workspace: WorkspaceState;
  // 並びは表示順。束の中は RANK_* の昇順、同順位は state の並び。
  rows: readonly PaneRow[];
  // 帯に出す件数。表示している行を状態で数える（窓口も 1 行として数える）。
  counts: Readonly<Record<ActiveStatus, number>>;
};

// アクティブの行をワークスペース単位で束ねる。同じワークツリーの行が状態順で散らばると、
// どれが同じ場所かを目で追えないため。束の順は、束の中で最も上位の行の順位。
// 同順位は窓口の新しさ、次に state の並び。
export function activeGroups(
  state: AppState,
  sent: ReadonlyMap<string, SentPane>,
): readonly ActiveGroup[] {
  const windows = sentPanes(state, sent);
  const rows = activePanes(state);
  const inWindow = new Set(windows.map((row) => row.pane.id));
  const sentAt = new Map([...sent.values()].map((entry) => [entry.paneId, entry.at]));

  const ordered: { row: PaneRow; rank: number }[] = [];
  for (const row of rows) {
    if (row.pane.agentStatus === "blocked") ordered.push({ row, rank: RANK_BLOCKED });
  }
  for (const row of windows) ordered.push({ row, rank: RANK_WINDOW });
  for (const row of rows) {
    if (row.pane.agentStatus === "done" && !inWindow.has(row.pane.id)) {
      ordered.push({ row, rank: RANK_DONE });
    }
  }
  for (const row of rows) {
    if (row.pane.agentStatus === "working" && !inWindow.has(row.pane.id)) {
      ordered.push({ row, rank: RANK_WORKING });
    }
  }

  const order = new Map(state.workspaces.map((workspace, index) => [workspace.id, index]));
  const buckets = new Map<
    string,
    { workspace: WorkspaceState; rows: PaneRow[]; rank: number; windowAt: number }
  >();
  for (const { row, rank } of ordered) {
    const existing = buckets.get(row.workspace.id);
    if (existing === undefined) {
      buckets.set(row.workspace.id, {
        workspace: row.workspace,
        rows: [row],
        rank,
        windowAt: sentAt.get(row.pane.id) ?? Number.NEGATIVE_INFINITY,
      });
      continue;
    }
    existing.rows.push(row);
    existing.rank = Math.min(existing.rank, rank);
    const at = sentAt.get(row.pane.id);
    if (at !== undefined) existing.windowAt = at;
  }

  return [...buckets.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.windowAt === b.windowAt ? 0 : b.windowAt - a.windowAt) ||
        (order.get(a.workspace.id) ?? 0) - (order.get(b.workspace.id) ?? 0),
    )
    .map((group) => ({
      workspace: group.workspace,
      rows: group.rows,
      counts: countRows(group.rows),
    }));
}

function countRows(rows: readonly PaneRow[]): Record<ActiveStatus, number> {
  const counts: Record<ActiveStatus, number> = { blocked: 0, working: 0, done: 0 };
  for (const row of rows) {
    if (isActiveStatus(row.pane.agentStatus)) counts[row.pane.agentStatus] += 1;
  }
  return counts;
}

// タブが 1 つだけなら、行にタブ名を添えても同じ値を繰り返すだけ。既定名の「1」は出さない。
export function showsTabName(workspace: WorkspaceState): boolean {
  return workspace.tabs.length > 1;
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

// 既読は「見終わったとき」に送る。開いた時点で送ると、読んでいる間に行が消える。
// 保留はアクティブ一覧の行を開いたときだけ作るので、ここでは登録元を問わない。
// 同じ行の再選択は離れていないので送らない。消えたペイン（status が null）も送らない。
export function shouldFocusOnLeave(
  pendingPaneId: string | null,
  nextPaneId: string | null,
  status: AgentStatus | null,
): boolean {
  return pendingPaneId !== null && pendingPaneId !== nextPaneId && status === "done";
}
