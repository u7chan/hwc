import type { AppState } from "../../server/herdr/state";
import { parsePullRequest, type PullRequest } from "../../shared/pull-request";
import {
  CLOSE_TIMEOUT_MS,
  type CloseOutcome,
  client,
  closeOutcome,
  createWithIds,
  toCreationFailure,
  toKnownError,
  withJson,
  workspaceParam,
} from "../api";

export function toAppState(value: unknown): AppState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<AppState>;
  if (!Array.isArray(state.workspaces)) return null;
  return state as AppState;
}

// 状態と、送信時のサーバー時刻。クライアントは now で時計を合わせる。
export type StateMessage = { state: AppState; now: number | null };

export function toStateMessage(value: unknown): StateMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { state?: unknown; now?: unknown };
  const state = toAppState(message.state);
  if (state === null) return null;
  // 読めない now では時計を合わせ直さない。前回の差をそのまま使う。
  const now = typeof message.now === "number" && Number.isFinite(message.now) ? message.now : null;
  return { state, now };
}

export function parseAppState(data: string): StateMessage | null {
  try {
    return toStateMessage(JSON.parse(data));
  } catch {
    return null;
  }
}

export async function fetchRevision(signal?: AbortSignal): Promise<string | null> {
  const response = await client.api.health.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`health: ${response.status}`);
  const body = await response.json();
  return typeof body.revision === "string" ? body.revision : null;
}

export async function fetchState(signal?: AbortSignal): Promise<StateMessage> {
  const response = await client.api.state.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(`state: ${response.status}`);
  const message = toStateMessage(await response.json());
  if (message === null) throw new Error("state: unexpected body");
  return message;
}

// Herdr がイベントを出さない cwd とブランチを追うための取り直しを頼む。応答は状態ではない。
// 新しい状態は SSE で届くので、ここでは成否だけを見る（docs/adr/bff-client-transport.md）。
export async function refreshState(signal?: AbortSignal): Promise<void> {
  const response = await client.api.state.refresh.$post({ json: {} }, { init: { signal } });
  if (!response.ok) throw new Error(`state refresh: ${response.status}`);
}

// ブランチから引いた最新の PR。チップや概要を出すためだけの値なので、失敗は null に畳む。
export async function readPullRequest(
  workspaceId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<PullRequest | null> {
  // BFF のキャッシュを飛ばすのは、一覧に戻ったときだけ。通常の取得はキャッシュに任せる。
  const input =
    options.refresh === true
      ? { ...workspaceParam(workspaceId), query: { refresh: "1" } }
      : workspaceParam(workspaceId);
  const response = await client.api.workspaces[":id"]["pull-request"].$get(input, {
    init: { signal: options.signal },
  });
  if (!response.ok) throw new Error(`pull-request: ${response.status}`);
  const body = (await response.json()) as { pullRequest?: unknown };
  return parsePullRequest(body.pullRequest);
}

export type GitSyncFailure =
  | "no_remote"
  | "no_upstream"
  | "not_git_worktree"
  | "git_unavailable"
  | "failed";

const GIT_SYNC_FAILURES: readonly GitSyncFailure[] = [
  "no_remote",
  "no_upstream",
  "not_git_worktree",
  "git_unavailable",
];

export type GitSyncOutcome = { ok: true } | { ok: false; error: GitSyncFailure };

// fetch / pull はネットワークと git の走査を伴う。
export const GIT_SYNC_TIMEOUT_MS = 70_000;

export async function syncWorkspace(
  workspaceId: string,
  action: "fetch" | "pull",
): Promise<GitSyncOutcome> {
  try {
    const input = { ...workspaceParam(workspaceId), json: { action } };
    const response = await client.api.workspaces[":id"].git.$post(input, {
      init: { signal: AbortSignal.timeout(GIT_SYNC_TIMEOUT_MS) },
    });
    if (response.ok) return { ok: true };
    const body: unknown = await response.json().catch(() => null);
    return { ok: false, error: toKnownError(body, GIT_SYNC_FAILURES) };
  } catch {
    return { ok: false, error: "failed" };
  }
}

// チェックアウトの削除は git の走査を含む。
export const REMOVE_WORKTREE_TIMEOUT_MS = 70_000;
// 消えたワークツリーは目的の状態に達している。close と同じく 404 は成功として扱う。
export async function removeWorktree(workspaceId: string): Promise<CloseOutcome> {
  try {
    const response = await client.api.workspaces[":id"]["remove-worktree"].$post(
      workspaceParam(workspaceId),
      {
        headers: { "content-type": "application/json" },
        init: { signal: AbortSignal.timeout(REMOVE_WORKTREE_TIMEOUT_MS) },
      },
    );
    return closeOutcome(response.status);
  } catch {
    return "failed";
  }
}

// スペースを閉じる。ファイルは消さないので、削除より短い期限で足りる。
// 消えたスペースは目的の状態に達しているため、close と同じく 404 は成功として扱う。
export async function closeWorkspace(workspaceId: string): Promise<CloseOutcome> {
  try {
    const response = await client.api.workspaces[":id"].close.$post(workspaceParam(workspaceId), {
      headers: { "content-type": "application/json" },
      init: { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) },
    });
    return closeOutcome(response.status);
  } catch {
    return "failed";
  }
}

// 並びは Herdr の状態そのもの。取り直しの分を少し上乗せする。
export const MOVE_WORKSPACES_TIMEOUT_MS = 10_000;

export async function moveWorkspaceBlock(
  workspaceIds: readonly string[],
  beforeWorkspaceId: string | null,
): Promise<boolean> {
  try {
    const response = await client.api.workspaces.move.$post(
      { json: { workspaceIds: [...workspaceIds], beforeWorkspaceId } },
      { init: { signal: AbortSignal.timeout(MOVE_WORKSPACES_TIMEOUT_MS) } },
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ワークツリー作成は worktree.create の待ちを含む。ここを短くすると、作成済みの
// ワークツリーを見失って再送してしまう。エージェントの起動はこの応答に含めない。
export const CREATE_WORKTREE_TIMEOUT_MS = 120_000;

export type CreateWorktreeFailure =
  | "pane_rename_failed"
  | "worktree_create_failed"
  | "worktree_open_failed"
  | "worktree_operation_in_progress"
  | "linked_worktree_source"
  | "not_git_worktree"
  | "workspace_not_found"
  | "invalid_request"
  | "herdr_unavailable"
  | "timeout"
  | "failed";

export type CreateWorktreeOutcome =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: CreateWorktreeFailure; workspaceId: string | null; paneId: string | null };

const WORKTREE_FAILURES: readonly CreateWorktreeFailure[] = [
  "pane_rename_failed",
  "worktree_create_failed",
  "worktree_open_failed",
  "worktree_operation_in_progress",
  "linked_worktree_source",
  "not_git_worktree",
  "workspace_not_found",
  "invalid_request",
  "herdr_unavailable",
];

export function toWorktreeError(value: unknown) {
  return toCreationFailure(value, WORKTREE_FAILURES);
}

// Herdr が作成失敗を明示した場合と、同じチェックアウトへの同時操作だけは待って再送できる。
// 期限切れ・通信断・worktree_open_failed は、チェックアウトができているか確認できない。
export function canRetryWorktree(error: CreateWorktreeFailure): boolean {
  return error === "worktree_create_failed" || error === "worktree_operation_in_progress";
}

export type CreateWorktreeRequest = { name: string | null };

export function createWorktree(
  workspaceId: string,
  request: CreateWorktreeRequest,
): Promise<CreateWorktreeOutcome> {
  return createWithIds(
    (signal) =>
      client.api.workspaces[":id"]["create-worktree"].$post(
        withJson(workspaceParam(workspaceId), request),
        { init: { signal } },
      ),
    toWorktreeError,
    CREATE_WORKTREE_TIMEOUT_MS,
  );
}
