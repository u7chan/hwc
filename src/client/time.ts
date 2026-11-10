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

// 完了した時刻は、観測した完了時刻をそのまま出す。覚えていなければ出さない。
export function finishedClock(
  finished: ReadonlyMap<string, number>,
  paneId: string,
): string | null {
  const at = finished.get(paneId);
  return at === undefined ? null : formatClock(at);
}

// サーバーの時計と端末の時計の差。状態を受けた場所で固定し、以後の描画では固定した値だけを
// 使う。毎回計算し直すと、状態が動かない間の「今」が送信時刻に張り付いて経過が止まる。
export function clockSkew(serverNow: number | null, receivedAt: number, previous: number): number {
  if (serverNow === null || !Number.isFinite(serverNow)) return previous;
  return receivedAt - serverNow;
}

// 差を戻して、サーバーの時計で「今」を出す。端末の時計がずれていても、経過も終了時刻も
// 全端末で同じ値になる。
export function serverClockNow(deviceNow: number, skew: number): number {
  return deviceNow - skew;
}
