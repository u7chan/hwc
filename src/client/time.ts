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
