import { parseWorkspaceCreated, type SpaceCreated } from "./contract";
import { request } from "./socket";

type Caller = <T>(
  method: string,
  params?: unknown,
  options?: { path?: string; timeoutMs?: number },
) => Promise<T>;

export type MoveWorkspacesRequest = {
  workspaceIds: readonly string[];
  beforeWorkspaceId: string | null;
};

export type WorkspaceClient = {
  create: (options: { cwd: string; label: string }) => Promise<SpaceCreated>;
  moveBlock: (options: MoveWorkspacesRequest) => Promise<void>;
  close: (workspaceId: string) => Promise<void>;
};

export function createWorkspaceClient(
  options: { path?: string; call?: Caller } = {},
): WorkspaceClient {
  const { path } = options;
  const call: Caller = options.call ?? request;

  return {
    // focus: true で新しいスペースへ移り、hwc もその最初のペインを開く（ワークツリーと同じ）。
    async create({ cwd, label }) {
      const result = await call("workspace.create", { cwd, label, focus: true }, { path });
      return parseWorkspaceCreated(result);
    },

    async moveBlock({ workspaceIds, beforeWorkspaceId }) {
      await call(
        "workspace.move_block",
        { workspace_ids: workspaceIds, before_workspace_id: beforeWorkspaceId },
        { path },
      );
    },

    // フォルダは残す。linked worktree の削除（worktree.remove）とは別の操作。
    async close(workspaceId) {
      await call("workspace.close", { workspace_id: workspaceId }, { path });
    },
  };
}
