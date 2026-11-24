import type { AppState } from "../../server/herdr/state";
import type { StartAgentOutcome } from "../requests/panes";
import { findPane } from "../select";
import { launchPhase, type LaunchIntent, type PaneLaunch } from "../starting";

// 記録の更新は純関数にする。時刻は呼んだ側が渡し、ここでは実時刻を読まない。
// 起動待ちの猶予（launchPhase の上限）を unit で確かめられるようにするため。

// ダイアログが決めた起動の指定を預かる。null は「起動せずに閉じた」で、記録を消す。
export function recordLaunch(
  current: ReadonlyMap<string, PaneLaunch>,
  paneId: string,
  intent: LaunchIntent | null,
  at: number,
): ReadonlyMap<string, PaneLaunch> {
  if (intent === null) return withoutLaunch(current, paneId);
  const next = new Map(current);
  next.set(paneId, {
    paneId,
    at,
    agent: intent.agent,
    model: intent.model,
    effort: intent.effort,
    request: "waiting",
    waitForShell: intent.waitForShell,
    error: null,
  });
  return next;
}

// 起動要求の結果を記録へ写す。記録そのものと照合するのは、再試行で置き換わった記録を
// 遅れて返った前の要求の結果で上書きしないため。
export function recordLaunchResult(
  current: ReadonlyMap<string, PaneLaunch>,
  launch: PaneLaunch,
  outcome: StartAgentOutcome,
  at: number,
): ReadonlyMap<string, PaneLaunch> {
  if (current.get(launch.paneId) !== launch) return current;
  // 別の経路で起動済みなら待ちを続ける。起動したかはスナップショットが決める。
  if (outcome.ok || outcome.error === "pane_not_shell") {
    return new Map(current).set(launch.paneId, { ...launch, request: "started", at, error: null });
  }
  return new Map(current).set(launch.paneId, {
    ...launch,
    request: "failed",
    at,
    error: outcome.error,
  });
}

// 起動に失敗したペインから、同じ指定でもう一度頼む。記録が無ければ何もしない。
export function recordRetry(
  current: ReadonlyMap<string, PaneLaunch>,
  paneId: string,
  at: number,
): ReadonlyMap<string, PaneLaunch> {
  const launch = current.get(paneId);
  if (launch === undefined) return current;
  return recordLaunch(current, paneId, intentOf(launch), at);
}

// 起動を諦め、残ったシェルとして使う。
export function withoutLaunch(
  current: ReadonlyMap<string, PaneLaunch>,
  paneId: string,
): ReadonlyMap<string, PaneLaunch> {
  if (!current.has(paneId)) return current;
  const next = new Map(current);
  next.delete(paneId);
  return next;
}

// 起動が終わった記録は、スナップショットが起動完了を示した時点で捨てる。記録は起動中だけの
// 一時的なもので、残すと後で /exit してシェルに戻ったときに「起動を確認できませんでした」が
// 蘇る。now は settle と上限の経過を見るために必要。
export function withoutSettledLaunches(
  current: ReadonlyMap<string, PaneLaunch>,
  state: AppState,
  now: number,
): ReadonlyMap<string, PaneLaunch> {
  let next: Map<string, PaneLaunch> | null = null;
  for (const [paneId, launch] of current) {
    const pane = findPane(state, paneId);
    if (pane === null) {
      // 新しいペインは、応答より先に記録だけができていることがある。届くまで残す。
      if (launch.request === "waiting") continue;
      next ??= new Map(current);
      next.delete(paneId);
      continue;
    }
    if (launchPhase(launch, pane, now) !== "ready") continue;
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}

function intentOf(launch: PaneLaunch): LaunchIntent {
  return {
    agent: launch.agent,
    model: launch.model,
    effort: launch.effort,
    waitForShell: launch.waitForShell,
  };
}
