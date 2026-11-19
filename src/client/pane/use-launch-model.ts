import { useEffect, useState } from "preact/hooks";
import { readLaunchModel } from "../api";
import type { AgentInfo } from "../chat";

// 会話がまだ読めない間の表示を、起動時の指定で補う（ADR 0101）。Claude は最初の
// メッセージまで transcript を作らず、その間はチャットではなく端末出力になる。
// 指定の無いペインでは取得がすぐ null で返る。
export function useLaunchModel(paneId: string, enabled: boolean): AgentInfo | null {
  const [info, setInfo] = useState<AgentInfo | null>(null);

  useEffect(() => {
    setInfo(null);
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    void readLaunchModel(paneId, controller.signal).then((value) => {
      if (active) setInfo(value);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [paneId, enabled]);

  return info;
}
