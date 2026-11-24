import { useEffect, useState } from "preact/hooks";
import type { ModelInfo } from "../api";
import type { AgentInfo } from "../chat";

// 会話にモデルが載るまでの表示の補い。取得と打ち切りだけを寄せ、待ちの見せ方（スケルトン）と
// 返り値は使う側に残す。
export function useModelInfo(
  read: (paneId: string, signal: AbortSignal) => Promise<ModelInfo | null>,
  paneId: string,
  enabled: boolean,
): { info: AgentInfo | null; resolved: boolean } {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    setInfo(null);
    setResolved(false);
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    void read(paneId, controller.signal).then((value) => {
      if (!active) return;
      setInfo(value);
      setResolved(true);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [read, paneId, enabled]);

  return { info, resolved };
}
