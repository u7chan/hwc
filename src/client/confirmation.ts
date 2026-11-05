import type { PaneState } from "../server/herdr/state";
import type { PaneInteraction } from "../shared/confirmation";

export function confirmationView(props: {
  pane: Pick<PaneState, "agent" | "chat" | "agentStatus">;
  interaction: PaneInteraction | null;
  dismissedId: string | null;
  failed: boolean;
}): "confirm" | "terminal" | "normal" {
  if (props.pane.agent !== "codex") return "normal";
  if (props.failed || props.interaction?.kind === "terminal") return "terminal";
  if (props.interaction?.kind === "codex-folder-trust") {
    return props.interaction.id === props.dismissedId ? "terminal" : "confirm";
  }
  return !props.pane.chat || props.pane.agentStatus === "blocked" ? "terminal" : "normal";
}
