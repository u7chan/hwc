import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatus } from "./contract";
import type { SnapshotState } from "./snapshot";

// 経過時間の起点と終了時刻。どちらも Herdr は返さないので BFF が唯一の持ち主になる。
// 端末ではなく 1 プロセスが持つため、どの端末から見ても同じ値になる（ADR 0017）。
export type PaneTimes = {
  workingSince: Record<string, number>;
  finishedAt: Record<string, number>;
};

const EMPTY_RECORD: Readonly<Record<string, number>> = Object.freeze({});

export const NO_TIMES: PaneTimes = Object.freeze({
  workingSince: EMPTY_RECORD,
  finishedAt: EMPTY_RECORD,
});

// 時刻を出す状態だけを保存する（blocked / unknown は時刻を持たない）。
export type PaneTimeStatus = "working" | "done" | "idle";

export type SavedPaneTimes = Record<string, { status: PaneTimeStatus; at: number }>;

function isPaneTimeStatus(value: unknown): value is PaneTimeStatus {
  return value === "working" || value === "done" || value === "idle";
}

function eachPane(
  state: SnapshotState,
  visit: (paneId: string, status: AgentStatus) => void,
): void {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) visit(pane.id, pane.agentStatus);
    }
  }
}

function sameRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// 前回の状態と比べて時刻を進める。遷移の規則はクライアントが持っていたものをそのまま移した。
//   working に入った時点を起点にし、working を離れたら起点を捨てる
//   working から done / idle へ移ったときだけ終了時刻を記録する
//   working と blocked に入ったら終了時刻を消す
// `observing` が false の観測（接続の切れ目・取得の失敗の後）では終了時刻を記録せず、
// 既に持っている時刻だけを残す。切れ目の間に起きた遷移を、観測したことにしない。
// 起点は止めない。working を見た時点から数えないと、切断中に働き始めたペインの経過が出ない。
export function trackPaneTimes(
  previous: SnapshotState | null,
  times: PaneTimes,
  next: SnapshotState,
  now: number,
  observing: boolean,
): PaneTimes {
  const worked = new Set<string>();
  if (previous !== null) {
    eachPane(previous, (paneId, status) => {
      if (status === "working") worked.add(paneId);
    });
  }

  const workingSince: Record<string, number> = {};
  const finishedAt: Record<string, number> = {};
  eachPane(next, (paneId, status) => {
    if (status === "working") {
      workingSince[paneId] = times.workingSince[paneId] ?? now;
      return;
    }
    if (status !== "done" && status !== "idle") return;
    const at = times.finishedAt[paneId];
    if (at !== undefined) finishedAt[paneId] = at;
    else if (observing && worked.has(paneId)) finishedAt[paneId] = now;
  });

  const unchanged =
    sameRecord(workingSince, times.workingSince) && sameRecord(finishedAt, times.finishedAt);
  return unchanged ? times : { workingSince, finishedAt };
}

// 保存した時刻を、いまのスナップショットに突き合わせて戻す。状態が一致する項目だけを
// 引き継ぐ。一致しない working は引き継がず、最初の観測から数え直す（数えないと、
// 後で done になっても終了時刻を記録できず、表示が今より減る）。
export function restorePaneTimes(saved: SavedPaneTimes, next: SnapshotState): PaneTimes {
  const workingSince: Record<string, number> = {};
  const finishedAt: Record<string, number> = {};
  eachPane(next, (paneId, status) => {
    const entry = saved[paneId];
    if (entry === undefined) return;
    if (status === "working" && entry.status === "working") workingSince[paneId] = entry.at;
    else if ((status === "done" || status === "idle") && entry.status === status)
      finishedAt[paneId] = entry.at;
  });
  return { workingSince, finishedAt };
}

// 保存する形。状態も一緒に残すのは、再起動時に「同じ状態のままか」を突き合わせるため。
export function toSavedPaneTimes(state: SnapshotState, times: PaneTimes): SavedPaneTimes {
  const saved: SavedPaneTimes = {};
  eachPane(state, (paneId, status) => {
    if (status === "working") {
      const at = times.workingSince[paneId];
      if (at !== undefined) saved[paneId] = { status, at };
      return;
    }
    if (status !== "done" && status !== "idle") return;
    const at = times.finishedAt[paneId];
    if (at !== undefined) saved[paneId] = { status, at };
  });
  return saved;
}

// 保存した時刻を読む。壊れた JSON・非数・読んだ時刻より未来の値は捨てる
// （端末ではなく BFF の時計だが、時計が戻ったときに負の経過を出さない）。
export function parseSavedPaneTimes(raw: string | null, now: number): SavedPaneTimes {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const saved: SavedPaneTimes = {};
  for (const [paneId, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { status, at } = entry as { status?: unknown; at?: unknown };
    if (!isPaneTimeStatus(status)) continue;
    if (typeof at !== "number" || !Number.isFinite(at) || at > now) continue;
    saved[paneId] = { status, at };
  }
  return saved;
}

// 保存の読み書き。中身は JSON のまま扱い、解釈は parseSavedPaneTimes に任せる。
export type PaneTimesFile = {
  read: () => string | null;
  write: (raw: string) => void;
};

export function paneTimesPath(root: string): string {
  return join(root, "pane-times.json");
}

// 状態ディレクトリ配下の 1 ファイル。同じディレクトリの tmp に書いてから rename で置き換え、
// 途中で落ちても半端な JSON を残さない。非同期にすると書き込みの完了順が publish の順と
// ずれ、古い内容で新しい内容を上書きしうるので同期で書く（publish は状態変化のときだけ）。
export function createPaneTimesFile(root: string): PaneTimesFile {
  const path = paneTimesPath(root);
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // まだ無いときと読めないときを区別しない。時刻を出さないだけなので起動は止めない。
        return null;
      }
    },
    write: (raw) => {
      mkdirSync(root, { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, raw);
      renameSync(tmp, path);
    },
  };
}
