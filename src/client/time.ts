import type { AppState } from "../server/herdr/state";

// 1 時間を超えたら秒は落とす。目安として読めれば十分なので。
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// 会話の時刻は時:分だけ。秒まで出しても読めないので。
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// 返答待ちの経過は、稼働に入った時刻からの差で出す。覚えていなければ出さない。
export function workingMs(
  since: ReadonlyMap<string, number>,
  paneId: string,
  now: number,
): number | null {
  const at = since.get(paneId);
  return at === undefined ? null : Math.max(0, now - at);
}

// 稼働に入った時刻を覚えておく。Herdr は変化の順序だけを返すので、開始時刻はこちらで持つ。
export function trackWorking(
  since: ReadonlyMap<string, number>,
  state: AppState,
  now: number,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agentStatus === "working") next.set(pane.id, since.get(pane.id) ?? now);
      }
    }
  }

  const unchanged = next.size === since.size && [...next].every(([id, at]) => since.get(id) === at);
  return unchanged ? since : next;
}

export const WORKING_SINCE_STORAGE_KEY = "hwc-working-since";
export const FINISHED_AT_STORAGE_KEY = "hwc-finished-at";

// 保存した時刻を読み直す。状態はまだ届いていないので、どのペインの値かは最初の
// スナップショットで絞る。ここでは数の健全さだけを見る。未来の値は、端末の時計が
// 戻ったときに負の経過を出さないよう捨てる。
function parsePaneTimes(raw: string | null, now: number): ReadonlyMap<string, number> {
  if (raw === null) return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();

  const times = new Map<string, number>();
  for (const [paneId, at] of Object.entries(value)) {
    if (typeof at !== "number" || !Number.isFinite(at) || at > now) continue;
    times.set(paneId, at);
  }
  return times;
}

export function parseWorkingSince(raw: string | null, now: number): ReadonlyMap<string, number> {
  return parsePaneTimes(raw, now);
}

export function parseFinishedAt(raw: string | null, now: number): ReadonlyMap<string, number> {
  return parsePaneTimes(raw, now);
}

// 保存するのは、いま working と分かっているペインの起点だけ。止まったペインの値を
// 残すと、次に働き始めたときに古い起点から数えてしまう。
export function workingSinceForSave(
  state: AppState,
  since: ReadonlyMap<string, number>,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agentStatus !== "working") continue;
        const at = since.get(pane.id);
        if (at !== undefined) record[pane.id] = at;
      }
    }
  }
  return record;
}

// 完了した時刻は、観測した完了時刻をそのまま出す。覚えていなければ出さない。
export function finishedClock(
  finished: ReadonlyMap<string, number>,
  paneId: string,
): string | null {
  const at = finished.get(paneId);
  return at === undefined ? null : formatClock(at);
}

// 完了時刻は、直前の観測で working だったペインが done / idle に移ったときだけ記録する。
// working と blocked では消す（要対応は待ち時間ではなく、こちらが動く番なので）。
// `observing` が false のスナップショット（マウント直後と再接続後の最初）では記録せず、
// 既に持っている時刻だけを残す。別端末で見た完了を、この端末の観測として捏造しない。
export function trackFinished(
  finished: ReadonlyMap<string, number>,
  worked: ReadonlyMap<string, number>,
  state: AppState,
  now: number,
  observing: boolean,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.agentStatus !== "done" && pane.agentStatus !== "idle") continue;
        const at = finished.get(pane.id);
        if (at !== undefined) next.set(pane.id, at);
        else if (observing && worked.has(pane.id)) next.set(pane.id, now);
      }
    }
  }

  const unchanged =
    next.size === finished.size && [...next].every(([id, at]) => finished.get(id) === at);
  return unchanged ? finished : next;
}
