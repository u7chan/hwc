import type { WorkspaceState } from "../server/herdr/state";
import type { WorkspaceGroup } from "./select";

// 一覧の最上位ブロック。リポジトリ束か、ワークツリーを持たない単独のスペース。
// key は表示の識別子、ids は Herdr のワークスペース順。
export type OrderUnit = {
  key: string;
  label: string;
  ids: readonly string[];
};

// 束の中の順序は Herdr のワークスペース順のまま保つ。表示は本体を先頭にするが、
// move_block に渡す順を組み替えると、ネイティブの linked worktree の並びまで変わる。
export function orderUnits(
  groups: readonly WorkspaceGroup[],
  workspaces: readonly WorkspaceState[],
): readonly OrderUnit[] {
  const index = new Map(workspaces.map((workspace, at) => [workspace.id, at]));
  return groups.map((group) => {
    const members = group.host === null ? group.linked : [group.host, ...group.linked];
    const ids = [...members]
      .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
      .map((workspace) => workspace.id);
    return { key: group.key, label: group.repoName ?? members[0]?.label ?? group.key, ids };
  });
}

export type UnitRect = { key: string; top: number; bottom: number };

// 指の位置から、残りのブロックのどこへ落とすかを決める。返り値は「このブロックの前」。
// null は末尾。掴んでいるブロック自身は呼び出し側で除く。
export function dropAnchor(rects: readonly UnitRect[], y: number): string | null {
  for (const rect of rects) {
    if (y < (rect.top + rect.bottom) / 2) return rect.key;
  }
  return null;
}

export function dropBeforeId(units: readonly OrderUnit[], beforeKey: string | null): string | null {
  if (beforeKey === null) return null;
  return units.find((unit) => unit.key === beforeKey)?.ids[0] ?? null;
}

// 残りだけにしたときの挿入位置が、移動前と同じなら送らない。
export function isOrderChange(
  units: readonly OrderUnit[],
  movedKey: string,
  beforeKey: string | null,
): boolean {
  const from = units.findIndex((unit) => unit.key === movedKey);
  if (from < 0) return false;

  const rest = units.filter((unit) => unit.key !== movedKey);
  const to = beforeKey === null ? rest.length : rest.findIndex((unit) => unit.key === beforeKey);
  return to >= 0 && to !== from;
}

// キーボードで 1 つ動かす。返り値は落とし先の前のキー、末尾は null、動かせないときは undefined。
export function adjacentBeforeKey(
  units: readonly OrderUnit[],
  movedKey: string,
  direction: -1 | 1,
): string | null | undefined {
  const from = units.findIndex((unit) => unit.key === movedKey);
  if (from < 0) return undefined;

  const rest = units.filter((unit) => unit.key !== movedKey);
  const to = from + direction;
  if (to < 0 || to > rest.length) return undefined;
  return rest[to]?.key ?? null;
}
