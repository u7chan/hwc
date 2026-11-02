import type { WorkspaceState } from "../server/herdr/state";

export type ListScope = "agent" | "all";

export const LIST_SCOPE_STORAGE_KEY = "hwc-list-scope";

// 既定はエージェントのいるスペースだけ。シェルだけのスペースは、そこで
// エージェントを起こすときに「すべて」で探す。
export function parseListScope(raw: string | null): ListScope {
  return raw === "all" ? "all" : "agent";
}

export function workspaceHasAgent(workspace: WorkspaceState): boolean {
  return workspace.tabs.some((tab) => tab.panes.some((pane) => pane.agent !== null));
}

// 絞り込んでも、いま開いているスペースだけは残す。読んでいるものが消えるほうが困る。
export function scopeWorkspaces(
  workspaces: readonly WorkspaceState[],
  scope: ListScope,
  selectedPaneId: string | null,
): readonly WorkspaceState[] {
  if (scope === "all") return workspaces;
  return workspaces.filter(
    (workspace) =>
      workspaceHasAgent(workspace) ||
      workspace.tabs.some((tab) => tab.panes.some((pane) => pane.id === selectedPaneId)),
  );
}
