import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../../../server/herdr/state";
import { startAgent } from "../../requests/panes";
import { findPane } from "../../select";
import { type LaunchIntent, type PaneLaunch } from "../../starting";
import { serverClockNow } from "../../time";
import {
  recordLaunch,
  recordLaunchResult,
  recordRetry,
  withoutLaunch,
  withoutSettledLaunches,
} from "../launch";

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
    setLaunches((current) =>
      recordLaunch(current, paneId, intent, serverClockNow(Date.now(), skew.current)),
    );
  };

  // 分割の応答より先に Herdr の状態が届かないことがあり、その間は BFF もペインを知らない。
  // スナップショットに現れてから頼む。要求の結果は記録の同一性で照合し、起動したかは
  // スナップショットに決めさせる。
  useEffect(() => {
    if (state === null) return;

    const run = async (launch: PaneLaunch) => {
      const outcome = await startAgent(launch.paneId, {
        agent: launch.agent,
        model: launch.model,
        effort: launch.effort,
        waitForShell: launch.waitForShell,
      });
      launchRequests.current.delete(launch);
      setLaunches((current) =>
        recordLaunchResult(current, launch, outcome, serverClockNow(Date.now(), skew.current)),
      );
    };

    for (const launch of launches.values()) {
      if (launch.request !== "waiting") continue;
      if (launchRequests.current.has(launch)) continue;
      if (findPane(state, launch.paneId) === null) continue;
      launchRequests.current.add(launch);
      void run(launch);
    }
  }, [state, launches]);

  useEffect(() => {
    if (launches.size === 0 || state === null) return;
    setLaunches((current) => withoutSettledLaunches(current, state, now));
  }, [state, launches, now]);

  // 起動に失敗したペインから、同じ指定でもう一度頼む。
  const retryLaunch = (paneId: string) => {
    setLaunches((current) =>
      recordRetry(current, paneId, serverClockNow(Date.now(), skew.current)),
    );
  };

  // 起動を諦め、残ったシェルとして使う。入力欄もシェルの形に戻る。
  const useShell = (paneId: string) => setLaunches((current) => withoutLaunch(current, paneId));

  return { launches, beginLaunch, retryLaunch, useShell };
}
