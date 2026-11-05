import type { AppState } from "../server/herdr/state";
import { isAgentKind } from "./agents";

export type PaneCloseAction = "close" | "exit";

export function paneCloseAction(state: AppState, paneId: string): PaneCloseAction | "keep" | null {
  for (const workspace of state.workspaces) {
    const panes = workspace.tabs.flatMap((tab) => tab.panes);
    const pane = panes.find((item) => item.id === paneId);
    if (pane === undefined) continue;
    if (panes.length > 1) return "close";
    return isAgentKind(pane.agent) ? "exit" : "keep";
  }
  return null;
}
