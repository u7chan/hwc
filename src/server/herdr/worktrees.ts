import { parseWorktreeCreated, type WorktreeCreated } from "./contract";
import { request } from "./socket";

// worktree.create は git worktree add とスペースの生成を行う。worktree.remove と同じく、
// ペインの操作（8 秒）より時間がかかる。
const CREATE_TIMEOUT_MS = 60_000;

// git worktree remove はチェックアウト全体を走査する。未追跡のファイルも消すので、
// ペインの操作（8 秒）より時間がかかる。
const REMOVE_TIMEOUT_MS = 60_000;

type Caller = (
  method: string,
  params?: unknown,
  options?: { path?: string; timeoutMs?: number },
) => Promise<unknown>;

export type WorktreeClient = {
  create: (options: { workspaceId: string }) => Promise<WorktreeCreated>;
  remove: (options: { workspaceId: string }) => Promise<void>;
};

export function createWorktreeClient(
  options: { path?: string; call?: Caller } = {},
): WorktreeClient {
  const { path } = options;
  const call: Caller = options.call ?? request;

  return {
    async create({ workspaceId }) {
      // ブランチ名・保存先・base は送らず、Herdr の自動生成と設定に任せる。focus: true で
      // 新しいスペースへ移り、hwc もその最初のペインを開く。
      const result = await call(
        "worktree.create",
        { workspace_id: workspaceId, focus: true },
        { path, timeoutMs: CREATE_TIMEOUT_MS },
      );
      return parseWorktreeCreated(result);
    },
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
