import type { AgentModel } from "../shared/agents";
import type { ChatSnapshot } from "./chat/contract";

type LaunchSelection = { model: string; effort: string | null };

// pi は最初のメッセージまでセッション JSONL を書かず、/new の後も同じ状態に戻る。
// 起動時に指定した値は、ペインのエージェントが終わるまで表示の補いとして預かる。
// 会話にモデルが載っても捨てないのは、/new が起動時の指定を引き継ぐため（docs/adr/agent-launch.md）。
// 正はセッションのまま（docs/adr/agent-launch.md）。
export function createLaunchModels() {
  const selections = new Map<string, LaunchSelection>();

  return {
    remember(paneId: string, model: AgentModel, effort: string | null): void {
      selections.set(paneId, { model: model.id, effort });
    },
    forget(paneId: string): void {
      selections.delete(paneId);
    },
    read(paneId: string): LaunchSelection | null {
      return selections.get(paneId) ?? null;
    },
    apply(paneId: string, snapshot: ChatSnapshot): ChatSnapshot {
      const selection = selections.get(paneId);
      if (selection === undefined) return snapshot;
      if (snapshot.model !== null) return snapshot;
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
