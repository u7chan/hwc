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

export type ParsedMoveWorkspaces =
  | { ok: true; value: MoveWorkspacesRequest }
  | { ok: false; error: string };

// 一覧の単位はリポジトリ束で、複数の workspace id をまとめて動かす。1 つずつ動かすと
// linked worktree が束から離れ、途中で失敗したときに束が割れる。
export function parseMoveWorkspacesBody(body: unknown): ParsedMoveWorkspaces {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }

  const record = body as Record<string, unknown>;
  const rawIds = record.workspaceIds;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    !rawIds.every((id) => typeof id === "string" && id !== "")
  ) {
    return { ok: false, error: "workspaceIds must be a non-empty array of strings" };
  }
  const workspaceIds = rawIds as string[];
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    return { ok: false, error: "workspaceIds must be unique" };
  }

  const rawBefore = record.beforeWorkspaceId;
  if (rawBefore !== undefined && rawBefore !== null && typeof rawBefore !== "string") {
    return { ok: false, error: "beforeWorkspaceId must be a string or null" };
  }
  if (typeof rawBefore === "string" && rawBefore === "") {
    return { ok: false, error: "beforeWorkspaceId must not be empty" };
  }
  const beforeWorkspaceId = typeof rawBefore === "string" ? rawBefore : null;
  if (beforeWorkspaceId !== null && workspaceIds.includes(beforeWorkspaceId)) {
    return { ok: false, error: "beforeWorkspaceId must not be in workspaceIds" };
  }

  return { ok: true, value: { workspaceIds, beforeWorkspaceId } };
}

export type WorkspaceClient = {
  moveBlock: (options: MoveWorkspacesRequest) => Promise<void>;
  close: (workspaceId: string) => Promise<void>;
};

export function createWorkspaceClient(
  options: { path?: string; call?: Caller } = {},
): WorkspaceClient {
  const { path } = options;
  const call: Caller = options.call ?? request;

  return {
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
