import { type SetupClient, type PaneSetupFailure, setupPane } from "./create-pane";
import type { SplitRequest } from "./herdr/panes";
import type { WorktreeClient } from "./herdr/worktrees";
import type { AgentModelsClient } from "./agent-models";

type CreateWorktreeResult =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: PaneSetupFailure; workspaceId: string; paneId: string };

// ワークツリーの作成と最初のペインの起動を 1 リクエストで行う。root pane は Herdr が
// シェルとして作るので、分割はせずにそのペインへエージェントを起動する。
export async function createWorktree(
  worktrees: Pick<WorktreeClient, "create">,
  panes: SetupClient,
  workspaceId: string,
  request: SplitRequest,
  models?: AgentModelsClient,
): Promise<CreateWorktreeResult> {
  const created = await worktrees.create({ workspaceId });
  const error = await setupPane(panes, created.paneId, request, models);

  return error === null ? { ok: true, ...created } : { ok: false, error, ...created };
}
