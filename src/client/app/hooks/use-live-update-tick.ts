import { useEffect } from "preact/hooks";
import { refreshState } from "../../requests/workspaces";
import { liveUpdateAllowed } from "../../live-update";

// 状態の取り直しを頼むだけで、応答は状態として適用しない。新しい状態は SSE で届く
// （docs/adr/herdr-socket.md）。間隔が 0 のときは何もしない。
export function useLiveUpdateTick(intervalMs: number): void {
  useEffect(() => {
    if (intervalMs <= 0) return;

    const controller = new AbortController();
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight) return;
      if (!liveUpdateAllowed(document.visibilityState)) return;
      inFlight = true;
      try {
        await refreshState(controller.signal);
      } catch {
        // 取り直せなくても、Herdr のイベントか再接続で追いつく。
      } finally {
        inFlight = false;
      }
    };

    // 開いたとき・可視に戻ったときは、次の間隔を待たずに 1 回取り直す。
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    const onVisibility = () => void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
