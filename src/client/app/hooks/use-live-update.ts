import { useState } from "preact/hooks";
import { loadLiveUpdate, saveLiveUpdate, type LiveUpdateInterval } from "../../live-update";

export type UseLiveUpdate = {
  interval: LiveUpdateInterval;
  change: (next: LiveUpdateInterval) => void;
};

// ライブ更新の間隔は端末ごとの好み。テーマと同じく、読み書きは localStorage に閉じる（ADR 0120）。
export function useLiveUpdate(): UseLiveUpdate {
  const [interval, setCurrent] = useState<LiveUpdateInterval>(() =>
    loadLiveUpdate(typeof localStorage === "undefined" ? null : localStorage),
  );

  const change = (next: LiveUpdateInterval) => {
    setCurrent(next);
    if (typeof localStorage !== "undefined") saveLiveUpdate(localStorage, next);
  };

  return { interval, change };
}
