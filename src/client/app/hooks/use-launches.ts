import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../../../server/herdr/state";
import { startAgent } from "../../requests/panes";
import { findPane } from "../../select";
import { launchPhase, type LaunchIntent, type PaneLaunch } from "../../starting";
import { serverClockNow } from "../../time";

export type LaunchSource = {
  state: AppState | null;
  now: number;
  // 記録の時刻はサーバーの時計で刻む。スナップショットを受けた場所で固定した差を読む。
  skew: RefObject<number>;
};

export type LaunchHandle = {
  launches: ReadonlyMap<string, PaneLaunch>;
  beginLaunch: (paneId: string, intent: LaunchIntent | null) => void;
  retryLaunch: (paneId: string) => void;
  useShell: (paneId: string) => void;
};

export function useLaunches(source: LaunchSource): LaunchHandle {
  const { state, now, skew } = source;
  // 起動を頼んだペイン。ダイアログで選んだ内容だけを持ち、起動したかはスナップショットで決める。
  // 起動が終わるまでに別のペインも作れるので、ペイン id ごとに持つ。
  const [launches, setLaunches] = useState<ReadonlyMap<string, PaneLaunch>>(() => new Map());
  // 要求済みの記録。再試行で記録が置き換わっても、前の要求の完了が新しい要求の
  // 番人を消さないよう、ペイン id ではなく記録そのもので覚える。
  const launchRequests = useRef(new Set<PaneLaunch>());

  // ダイアログが決めた起動の指定を預かる。新しいペインはスナップショットに現れてから、
  // ペインごとに 1 回だけ起動を頼む。起動したかどうかの正はスナップショットに置く。
  const beginLaunch = (paneId: string, intent: LaunchIntent | null) => {
    setLaunches((current) => {
      const next = new Map(current);
      if (intent === null) {
        next.delete(paneId);
      } else {
        next.set(paneId, {
          paneId,
          at: serverClockNow(Date.now(), skew.current),
          agent: intent.agent,
          model: intent.model,
          effort: intent.effort,
          request: "waiting",
          waitForShell: intent.waitForShell,
          error: null,
        });
      }
      return next;
    });
  };

  // 分割の応答より先に Herdr の状態が届かないことがあり、その間は BFF もペインを知らない。
  // スナップショットに現れてから頼む。要求の結果は記録の同一性で照合し、起動したかは
  // スナップショットに決めさせる。
  useEffect(() => {
    if (state === null) return;

    const run = async (launch: PaneLaunch) => {
      const result = await startAgent(launch.paneId, {
        agent: launch.agent,
        model: launch.model,
        effort: launch.effort,
        waitForShell: launch.waitForShell,
      });
      launchRequests.current.delete(launch);
      setLaunches((current) => {
        // 再試行で別の記録に置き換わっていたら、遅れて返った結果で上書きしない。
        if (current.get(launch.paneId) !== launch) return current;
        // 別の経路で起動済みなら待ちを続ける。起動したかはスナップショットが決める。
        if (result.ok || result.error === "pane_not_shell") {
          return new Map(current).set(launch.paneId, {
            ...launch,
            request: "started",
            at: serverClockNow(Date.now(), skew.current),
            error: null,
          });
        }
        return new Map(current).set(launch.paneId, {
          ...launch,
          request: "failed",
          at: serverClockNow(Date.now(), skew.current),
          error: result.error,
        });
      });
    };

    for (const launch of launches.values()) {
      if (launch.request !== "waiting") continue;
      if (launchRequests.current.has(launch)) continue;
      if (findPane(state, launch.paneId) === null) continue;
      launchRequests.current.add(launch);
      void run(launch);
    }
  }, [state, launches]);

  // 起動が終わった記録は、スナップショットが起動完了を示した時点で捨てる。記録は起動中だけの
  // 一時的なもので、残すと後で /exit してシェルに戻ったときに「起動を確認できませんでした」が
  // 蘇る。now は settle と上限の経過を見るために必要。
  useEffect(() => {
    if (launches.size === 0 || state === null) return;
    setLaunches((current) => {
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
    });
  }, [state, launches, now]);

  // 起動に失敗したペインから、同じ指定でもう一度頼む。
  const retryLaunch = (paneId: string) => {
    const launch = launches.get(paneId);
    if (launch === undefined) return;
    beginLaunch(paneId, {
      agent: launch.agent,
      model: launch.model,
      effort: launch.effort,
      waitForShell: launch.waitForShell,
    });
  };

  // 起動を諦め、残ったシェルとして使う。入力欄もシェルの形に戻る。
  const useShell = (paneId: string) => {
    setLaunches((current) => {
      if (!current.has(paneId)) return current;
      const next = new Map(current);
      next.delete(paneId);
      return next;
    });
  };

  return { launches, beginLaunch, retryLaunch, useShell };
}
