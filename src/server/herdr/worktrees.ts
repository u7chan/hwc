import { request } from "./socket";

// git worktree remove はチェックアウト全体を走査する。未追跡のファイルも消すので、
// ペインの操作（8 秒）より時間がかかる。
const REMOVE_TIMEOUT_MS = 60_000;

type Caller = (
  method: string,
  params?: unknown,
  options?: { path?: string; timeoutMs?: number },
) => Promise<unknown>;

export type WorktreeClient = {
  remove: (options: { workspaceId: string }) => Promise<void>;
};

export function createWorktreeClient(
  options: { path?: string; call?: Caller } = {},
): WorktreeClient {
  const { path } = options;
  const call: Caller = options.call ?? request;

  return {
    async remove({ workspaceId }) {
      // force を送らないと、未コミットの変更があるチェックアウトは Herdr が
      // dirty_worktree_requires_force で拒否する。消える前提は確認で伝えている。
      await call(
        "worktree.remove",
        { workspace_id: workspaceId, force: true },
        { path, timeoutMs: REMOVE_TIMEOUT_MS },
      );
    },
  };
}
