import { type CreatedSpaceResult, nameRootPane } from "./create-space";
import type { PaneClient } from "./herdr/panes";
import type { WorktreeClient } from "./herdr/worktrees";

export type CreateWorktreeRequest = { name: string | null };

// ワークツリーと root ペインを作り、名前を付ける。
export async function createWorktree(
  worktrees: Pick<WorktreeClient, "create">,
  panes: Pick<PaneClient, "rename">,
  workspaceId: string,
  request: CreateWorktreeRequest,
): Promise<CreatedSpaceResult> {
  const created = await worktrees.create({ workspaceId });
  return nameRootPane(panes, created, request.name);
}
