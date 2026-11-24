import { useEffect, useState } from "preact/hooks";
import { readDefaultModel } from "../api";
import type { AgentInfo } from "../chat";
import { useModelInfo } from "./use-model-info";

// サーバーが既定モデルの預かりを持たないペインでは、取得がすぐ null で返る。
// 一瞬だけスケルトンが見えるのを避け、待っているときだけ出す。
const SKELETON_DELAY_MS = 180;

// 会話にモデルが載るまでの表示を、チャット画面を開いたときにだけ読む。
export function useDefaultModel(
  paneId: string,
  enabled: boolean,
): { info: AgentInfo | null; loading: boolean } {
  const { info, resolved } = useModelInfo(readDefaultModel, paneId, enabled);
  const [skeleton, setSkeleton] = useState(false);

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
