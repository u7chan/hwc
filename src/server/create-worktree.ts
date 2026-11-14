import type { PaneClient } from "./herdr/panes";
import type { WorktreeClient } from "./herdr/worktrees";

export type CreateWorktreeRequest = { name: string | null };

type CreateWorktreeResult =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: "pane_rename_failed"; workspaceId: string; paneId: string };

// ワークツリーと root ペインを作り、名前を付ける。エージェントの起動は、ペインが
// スナップショットに現れてからクライアントが行う（ADR 0084）。
export async function createWorktree(
  worktrees: Pick<WorktreeClient, "create">,
  panes: Pick<PaneClient, "rename">,
  workspaceId: string,
  request: CreateWorktreeRequest,
): Promise<CreateWorktreeResult> {
  const created = await worktrees.create({ workspaceId });
  if (request.name === null) return { ok: true, ...created };

  try {
    await panes.rename({ paneId: created.paneId, label: request.name });
  } catch {
    // 名前は表示だけで、ペインと起動は続けられる。クライアントは理由を見せずに起動する。
    return { ok: false, error: "pane_rename_failed", ...created };
  }
  return { ok: true, ...created };
}
