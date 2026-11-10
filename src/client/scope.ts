import type { AgentStatus, AppState, WorkspaceState } from "../server/herdr/state";
import { parentPaneOf, type PaneRow } from "./select";

export type ListScope = "active" | "all";

export const LIST_SCOPE_STORAGE_KEY = "hwc-list-scope";

// 既定はすべて。片付けたいスペースが既定で隠れると、消す入口（ADR 0034）に辿り着けない。
// 絞り込みは active が担う。旧値の agent などは既定へ倒す。
export function parseListScope(raw: string | null): ListScope {
  return raw === "active" ? "active" : "all";
}

// 帯に出す件数の状態。待機と不明は数えない。待機はどの帯にも並ぶ既定の状態なので、
// 数字にしても「自分が動く番」を見つける助けにならない。
const COUNTED_STATUSES = ["blocked", "working", "done"] as const;

export type ActiveStatus = (typeof COUNTED_STATUSES)[number];

function isCountedStatus(status: AgentStatus): status is ActiveStatus {
  return (COUNTED_STATUSES as readonly AgentStatus[]).includes(status);
}

export type ActivePane = PaneRow;

// エージェントが起動しているペインは、状態に関わらず 1 行ずつ並べる。Herdr の agents
// パネルと同じく、待機中でも「そこに居る」ことが分かるようにする。シェルは出さない。
// 並びは state のまま（ワークスペース → タブ → ペイン）。表示順は activeGroups が持つ。
export function activePanes(state: AppState): readonly ActivePane[] {
  const rows: ActivePane[] = [];
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agent === null) continue;
        rows.push({ workspace, tab, pane });
      }
    }
  }
  return rows;
}

// 束の中の順位。上から「自分が動く番 → 読む番 → 待つ番」。待機と不明を最後にまとめ、
// 動いている行や未読の完了を押し下げない。
const RANKS: Readonly<Record<AgentStatus, number>> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

export type ActiveGroup = {
  workspace: WorkspaceState;
  // 並びは表示順。束の中は親ペインが先頭、残りは RANKS の昇順。同順位は state の並び。
  rows: readonly PaneRow[];
  // 帯に出す件数。表示している行を状態で数える。待機と不明は 0 のまま。
  counts: Readonly<Record<ActiveStatus, number>>;
};

// アクティブの行をワークスペース単位で束ねる。同じワークツリーの行が状態順で散らばると、
// どれが同じ場所かを目で追えないため。束の中は親ペイン（ADR 0054）を状態に関わらず
// 先頭に固定する。王冠は状態ではなく役割の印で、位置が状態で動くと戻り先を探すコストと
// 押し間違いにつながる。束の順は、親を含めた最も緊急な行の順位。同順位は state の並び。
export function activeGroups(state: AppState): readonly ActiveGroup[] {
  const order = new Map(state.workspaces.map((workspace, index) => [workspace.id, index]));
  const buckets = new Map<string, { workspace: WorkspaceState; rows: PaneRow[] }>();
  for (const row of activePanes(state)) {
    const bucket = buckets.get(row.workspace.id);
    if (bucket === undefined) {
      buckets.set(row.workspace.id, { workspace: row.workspace, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }

  return [...buckets.values()]
    .map((bucket) => {
      const parentId = parentPaneOf(bucket.workspace)?.id ?? null;
      const rows = [...bucket.rows].sort(
        (a, b) =>
          Number(b.pane.id === parentId) - Number(a.pane.id === parentId) ||
          RANKS[a.pane.agentStatus] - RANKS[b.pane.agentStatus],
      );
      // 先頭は親なので、束の順位は先頭行ではなく全行の最小値で決める。
      const rank = Math.min(...rows.map((row) => RANKS[row.pane.agentStatus]));
      return { workspace: bucket.workspace, rows, counts: countRows(rows), rank };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank || (order.get(a.workspace.id) ?? 0) - (order.get(b.workspace.id) ?? 0),
    )
    .map((group) => ({
      workspace: group.workspace,
      rows: group.rows,
      counts: group.counts,
    }));
}

function countRows(rows: readonly PaneRow[]): Record<ActiveStatus, number> {
  const counts: Record<ActiveStatus, number> = { blocked: 0, working: 0, done: 0 };
  for (const row of rows) {
    if (isCountedStatus(row.pane.agentStatus)) counts[row.pane.agentStatus] += 1;
  }
  return counts;
}

// タブが 1 つだけなら、行にタブ名を添えても同じ値を繰り返すだけ。既定名の「1」は出さない。
export function showsTabName(workspace: WorkspaceState): boolean {
  return workspace.tabs.length > 1;
}

// 3 桁を超えたら数えても読めない。件数は目安で足りる。
export function countLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

// 「すべて」の見出しの副題。エージェントの有無を先に出す。シェルしか居ない束に
// 「エージェント 0」と書かず、何が居るかを言う。
export function agentPresence(agents: number): string {
  return agents === 0 ? "シェルのみ" : `エージェント ${agents}`;
}

// 既読は「見終わったとき」に送る。開いた時点で送ると、読んでいる間に完了の印が消える。
// 保留はアクティブ一覧の行を開いたときだけ作るので、ここでは登録元を問わない。
// 同じ行の再選択は離れていないので送らない。消えたペイン（status が null）も送らない。
export function shouldFocusOnLeave(
  pendingPaneId: string | null,
  nextPaneId: string | null,
  status: AgentStatus | null,
): boolean {
  return pendingPaneId !== null && pendingPaneId !== nextPaneId && status === "done";
}

// 保留は移動先に引き継ぐ。同じペインへの移動（詳細のタブバーやツリーで選び直したとき）は
// まだ離れていないので捨てない。開いた行（opened）はその場で保留を作る。
export function pendingReadAfter(
  pendingPaneId: string | null,
  nextPaneId: string | null,
  opened: boolean,
): string | null {
  return opened || pendingPaneId === nextPaneId ? nextPaneId : null;
}
