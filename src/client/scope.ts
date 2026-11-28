import type { AgentStatus, AppState, WorkspaceState } from "../server/herdr/state";
import { parentPaneOf } from "../shared/parent-pane";
import type { PaneRow } from "./select";

export type ListScope = "active" | "all";

export const LIST_SCOPE_STORAGE_KEY = "hwc-list-scope";

// 既定はすべて。片付けたいスペースが既定で隠れると、消す入口に辿り着けない。
// 絞り込みは active が担う。知らない保存値は既定へ倒し、起動を止めない。
export function parseListScope(raw: string | null): ListScope {
  return raw === "active" ? "active" : "all";
}

type StorageLike = { getItem: (key: string) => string | null };
type WritableStorage = StorageLike & { setItem: (key: string, value: string) => void };

export function loadListScope(storage: StorageLike | null): ListScope {
  if (!storage) return parseListScope(null);
  try {
    return parseListScope(storage.getItem(LIST_SCOPE_STORAGE_KEY));
  } catch {
    return parseListScope(null);
  }
}

export function saveListScope(storage: WritableStorage | null, scope: ListScope): void {
  if (!storage) return;
  try {
    storage.setItem(LIST_SCOPE_STORAGE_KEY, scope);
  } catch {
    // 保存だけ諦める。
  }
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

export type ActiveGroup = {
  workspace: WorkspaceState;
  // 並びは表示順。束の中は親ペインが先頭、残りは state の並び。
  rows: readonly PaneRow[];
  // 帯に出す件数。表示している行を状態で数える。待機と不明は 0 のまま。
  counts: Readonly<Record<ActiveStatus, number>>;
};

// アクティブの行をワークスペース単位で束ねる。同じワークツリーの行が散らばると、
// どれが同じ場所かを目で追えないため。束の中は親ペインを状態に関わらず
// 先頭に固定する。王冠は状態ではなく役割の印で、位置が状態で動くと戻り先を探すコストと
// 押し間違いにつながる。
//
// 状態では並べ替えない。状態で入れ替えると、働き始め・終わり・既読のたびに
// 行や束が指の下から動き、位置でペインを覚えられない。状態は行の記号と時刻、帯の件数で読む。
// 帯の順は利用者がドラッグで決めた並び（activeOrder）を先に使い、知らないスペースは
// 状態の順で後ろに置く。並びは BFF が持つので全端末で同じになる。
export function activeGroups(state: AppState): readonly ActiveGroup[] {
  const buckets = new Map<string, { workspace: WorkspaceState; rows: PaneRow[] }>();
  for (const row of activePanes(state)) {
    const bucket = buckets.get(row.workspace.id);
    if (bucket === undefined) {
      buckets.set(row.workspace.id, { workspace: row.workspace, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }

  // bucket は state を先頭から走査して作るので、挿入順がそのままワークスペース順になる。
  // 親を先頭にする分だけ、安定ソートで残りの state 順を保つ。
  const rank = new Map((state.activeOrder ?? []).map((id, at) => [id, at]));
  const unknown = Number.MAX_SAFE_INTEGER;
  return [...buckets.values()]
    .sort((a, b) => (rank.get(a.workspace.id) ?? unknown) - (rank.get(b.workspace.id) ?? unknown))
    .map((bucket) => {
      const parentId = parentPaneOf(bucket.workspace)?.id ?? null;
      const rows = [...bucket.rows].sort(
        (a, b) => Number(b.pane.id === parentId) - Number(a.pane.id === parentId),
      );
      return { workspace: bucket.workspace, rows, counts: countRows(rows) };
    });
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

// エージェントの数の札と、シェルしか居ない束の記号の名前。0 は数えず、
// 何が居るかを言う。束の副題は件数を出すので、ここでは使わない。
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
