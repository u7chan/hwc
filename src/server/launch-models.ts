import type { AgentModel } from "../shared/agents";
import type { ChatSnapshot } from "./chat/contract";

type LaunchSelection = { model: string; effort: string | null };

// pi は最初のメッセージまでセッション JSONL を書かないため、起動直後は会話からモデルを
// 読めない。起動時に指定した値だけを表示の補いとして預かり、セッションに値が載ったら
// 捨てる。正はセッションのまま（ADR 0013・0033）。
export function createLaunchModels() {
  const selections = new Map<string, LaunchSelection>();

  return {
    remember(paneId: string, model: AgentModel, effort: string | null): void {
      selections.set(paneId, { model: model.id, effort });
    },
    forget(paneId: string): void {
      selections.delete(paneId);
    },
    apply(paneId: string, snapshot: ChatSnapshot): ChatSnapshot {
      const selection = selections.get(paneId);
      if (selection === undefined) return snapshot;
      if (snapshot.model !== null) {
        selections.delete(paneId);
        return snapshot;
      }
      return {
        ...snapshot,
        // 補完の有無で本文が変わるので etag も変える。補完前の etag を持ったクライアントに
        // 304 を返さず、古い表示（モデル無し）を取り残させないため。
        etag: `${snapshot.etag}+launch`,
        model: selection.model,
        effort: snapshot.effort ?? selection.effort,
      };
    },
  };
}
