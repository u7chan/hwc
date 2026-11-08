import type { PaneState } from "../server/herdr/state";
import { supportsFolderTrust } from "../shared/agents";
import type { PaneInteraction } from "../shared/confirmation";

export type ConfirmationAttempt = "sending" | "waiting" | "failed";

export function confirmationView(props: {
  pane: Pick<PaneState, "agent" | "chat" | "agentStatus">;
  interaction: PaneInteraction | null;
  dismissedId: string | null;
  failed: boolean;
}): "confirm" | "terminal" | "normal" {
  if (!supportsFolderTrust(props.pane.agent)) return "normal";
  if (props.failed || props.interaction?.kind === "terminal") return "terminal";
  if (props.interaction?.kind === "folder-trust") {
    return props.interaction.id === props.dismissedId ? "terminal" : "confirm";
  }
  return props.pane.agentStatus === "blocked" ? "terminal" : "normal";
}
