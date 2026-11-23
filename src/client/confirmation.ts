import type { PaneState } from "../server/herdr/state";
import { supportsFolderTrust } from "../shared/agents";
import type { PaneInteraction } from "../shared/confirmation";

export type ConfirmationAttempt = "sending" | "waiting" | "failed";

export function confirmationView(props: {
  pane: Pick<PaneState, "agent" | "chat" | "agentStatus">;
  interaction: PaneInteraction | null;
  dismissedId: string | null;
  failed: boolean;
  // 会話の末尾に応答待ちのカードがあるか。カードから答えられる pi は端末へ倒さない。
  pending: boolean;
}): "confirm" | "terminal" | "normal" {
  if (!supportsFolderTrust(props.pane.agent)) return "normal";
  if (props.interaction?.kind === "terminal") return "terminal";
  if (props.interaction?.kind === "folder-trust") {
    // 読めなかった信頼確認は、今までどおり端末へ倒す。
    if (props.failed) return "terminal";
    return props.interaction.id === props.dismissedId ? "terminal" : "confirm";
  }
  // 質問カードは会話から読める。端末出力の取得に失敗しても、カードがあるなら会話を出す。
  // 信頼確認（confirm）と interaction: terminal は上の判定を変えない。
  if (props.pane.agent === "pi" && props.pane.agentStatus === "blocked" && props.pending) {
    return "normal";
  }
  if (props.failed) return "terminal";
  if (props.pane.agentStatus !== "blocked") return "normal";
  return "terminal";
}
