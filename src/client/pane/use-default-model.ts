import { useEffect, useState } from "preact/hooks";
import { readDefaultModel } from "../api";
import type { AgentInfo } from "../chat";

// サーバーが既定モデルの預かりを持たないペインでは、取得がすぐ null で返る。
// 一瞬だけスケルトンが見えるのを避け、待っているときだけ出す。
const SKELETON_DELAY_MS = 180;

// 会話にモデルが載るまでの表示を、チャット画面を開いたときにだけ読む。
export function useDefaultModel(
  paneId: string,
  enabled: boolean,
): { info: AgentInfo | null; loading: boolean } {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [resolved, setResolved] = useState(false);
  const [skeleton, setSkeleton] = useState(false);

  useEffect(() => {
    setInfo(null);
    setResolved(false);
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    void readDefaultModel(paneId, controller.signal).then((value) => {
      if (!active) return;
      setInfo(value === null ? null : { model: value.model, effort: value.effort });
      setResolved(true);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [paneId, enabled]);

  useEffect(() => {
    if (!enabled || resolved) {
      setSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, resolved]);

  return { info, loading: enabled && !resolved && skeleton };
}
