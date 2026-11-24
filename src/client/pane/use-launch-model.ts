import { readLaunchModel } from "../requests/panes";
import type { AgentInfo } from "../chat";
import { useModelInfo } from "./use-model-info";

// 会話がまだ読めない間の表示を、起動時の指定で補う（docs/adr/agent-launch.md）。Claude は最初の
// メッセージまで transcript を作らず、その間はチャットではなく端末出力になる。
// 指定の無いペインでは取得がすぐ null で返る。
export function useLaunchModel(paneId: string, enabled: boolean): AgentInfo | null {
  return useModelInfo(readLaunchModel, paneId, enabled).info;
}
