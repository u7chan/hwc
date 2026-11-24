import { basename } from "node:path";
import type { Context } from "hono";
import { createSpace } from "../create-space";
import { createWorktree } from "../create-worktree";
import { resolveTreeDirectory } from "../message-files";
import { parseMoveWorkspacesBody } from "../herdr/workspaces";
import { HerdrError } from "../herdr/socket";
import type { AppState } from "../herdr/state";
import { pullRequestBranches } from "../pull-request";
import { parseCreateSpaceBody, parseWorktreeBody } from "./panes-request";
import type { AppContext, IdContext, PlainContext } from "./context";

type FailureStatus = 400 | 404 | 409 | 502;

// 作成できたか・再試行できるかで分ける。ソケットの期限切れ・切断・応答 parser の失敗は
// 作成結果が不明なので herdr_unavailable へ畳み、クライアントに再送させない。
const WORKTREE_FAILURE_STATUS: Record<string, FailureStatus> = {
  worktree_create_failed: 502,
  worktree_open_failed: 502,
  worktree_operation_in_progress: 409,
  linked_worktree_source: 409,
  not_git_worktree: 409,
};

// スペースを閉じる操作は、フォルダを消さない。linked worktree の削除とは
// エラーコードも入口も分ける。グループを閉じる要求は勝手に通さない。
const CLOSE_SPACE_FAILURE_STATUS: Record<string, FailureStatus> = {
  workspace_group_close_required: 409,
};

const herdrFailure = (c: Context, error: unknown, statuses: Record<string, FailureStatus> = {}) => {
  if (error instanceof HerdrError) {
    if (error.code === "workspace_not_found") {
      return c.json({ error: "workspace_not_found" }, 404);
    }
    if (error.code === "invalid_params" || error.code === "invalid_request") {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 表は素のオブジェクトなので、prototype 由来の名前（toString など）を引くと関数が返る。
    // 未知のコードは変更前と同じく herdr_unavailable にする。
    if (Object.hasOwn(statuses, error.code)) {
      return c.json({ error: error.code }, statuses[error.code]);
    }
  }
  return c.json({ error: "herdr_unavailable" }, 502);
};

export function createWorkspacesHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    worktrees,
    workspaces,
    pullRequests,
    git,
    restartSettings,
    resolvePane,
    resolveState,
    scheduleRestart,
  } = ctx;

  // close 要求が同時に来ると、両方が「他にもスペースがある」チェックを通って 0 スペースまで
  // 閉じ得る。BFF は 1 プロセスなので、閉じている間と、閉じた直後の状態が届くまでの
  // workspace id を覚えておき、残りの数から外して後続の要求を 409 にする。
  const closingSpaces = new Set<string>();

  const releaseClosingSpace = (workspaceId: string) => {
    closingSpaces.delete(workspaceId);
  };

  // 状態から消えた id はもう閉じている。次の close 要求でガードを外す。
  const pruneClosingSpaces = (state: AppState) => {
    const live = new Set(state.workspaces.map((workspace) => workspace.id));
    for (const id of closingSpaces) {
      if (!live.has(id)) closingSpaces.delete(id);
    }
  };

  return {
    pullRequest: async (c: IdContext) => {
      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;
      const workspace = state.workspaces.find((item) => item.id === c.req.param("id"));
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

      // チップを出さないだけで足りるので、引けない場合は「PR が無い」と同じ応答にする。
      // gh の失敗や期限切れで画面を止めない。概要は merge 後も出すため、最新の PR を
      // 状態不問で返し、チップを出すかはクライアントが state で決める。
      c.header("cache-control", "no-store");
      const branch = workspace.branch ?? null;
      const checkoutPath = store.workspacePath(workspace.id);
      if (branch === null || checkoutPath === null || pullRequests === undefined) {
        return c.json({ pullRequest: null });
      }
      const refresh = c.req.query("refresh") === "1";
      // ワークツリーのブランチ名は Herdr の自動生成名で、PR の head は push 先の名前になる。
      // push 先を先に引き、見つからなければローカル名も見る。
      const branches = pullRequestBranches(branch, workspace.sync?.upstreamBranch ?? null);
      const pullRequest = await pullRequests({ checkoutPath, branches, refresh }).catch(() => null);
      return c.json({ pullRequest });
    },
    git: async (c: IdContext) => {
      const body = await c.req.json().catch(() => null);
      const action =
        typeof body === "object" && body !== null
          ? (body as { action?: unknown }).action
          : undefined;
      if (action !== "fetch" && action !== "pull") {
        return c.json({ error: "invalid_request" }, 400);
      }

      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

      const checkoutPath = store.workspacePath(workspace.id);
      if (checkoutPath === null) return c.json({ error: "not_git_worktree" }, 409);
      // ブランチが読めない場所は git のワークツリーではない。detached HEAD もここに入る。
      if (workspace.branch == null) return c.json({ error: "not_git_worktree" }, 409);
      if (git === undefined) return c.json({ error: "git_unavailable" }, 502);
      // 状態が古い場合も、クライアントが同じ条件で出し分けている。ここでは最後の砦。
      if (workspace.sync?.hasRemote !== true) {
        return c.json({ error: "no_remote" }, 409);
      }
      if (action === "pull" && workspace.sync?.upstream == null) {
        return c.json({ error: "no_upstream" }, 409);
      }

      try {
        if (action === "fetch") await git.fetch(checkoutPath);
        else await git.pull(checkoutPath);
      } catch {
        return c.json({ error: action === "fetch" ? "git_fetch_failed" : "git_pull_failed" }, 502);
      }

      // 次の状態公開で上流との差を読み直す。取得に失敗しても git の操作自体は終わっている。
      store.invalidateGit(workspace.id);
      await store.refresh().catch(() => {});

      // どのリポジトリで実行するかはコマンドが cwd で判定する。pull したチェックアウトを
      // 渡さないと、ガードが BFF 自身の cwd を見てしまい、ほかのスペースの pull でも再起動する。
      const restartCommand = restartSettings.get();
      if (action === "pull" && restartCommand.afterPull && restartCommand.command !== null) {
        scheduleRestart(restartCommand.command, checkoutPath);
      }
      return c.json({ ok: true });
    },
    move: async (c: PlainContext) => {
      const body = await c.req.json().catch(() => null);
      const parsed = parseMoveWorkspacesBody(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;

      // 状態に無い id は、クライアントと BFF の取り違え。Herdr に渡す前に止める。
      const known = new Set(state.workspaces.map((workspace) => workspace.id));
      if (!parsed.value.workspaceIds.every((id) => known.has(id))) {
        return c.json({ error: "workspace_not_found" }, 404);
      }
      const before = parsed.value.beforeWorkspaceId;
      if (before !== null && !known.has(before)) {
        return c.json({ error: "workspace_not_found" }, 404);
      }

      try {
        await workspaces.moveBlock(parsed.value);
      } catch (error) {
        return herdrFailure(c, error);
      }

      // イベントでも取り直すが、応答と SSE の前後で古い順に戻って見えるのを避ける。
      await store.refresh().catch(() => {});
      return c.json({ ok: true });
    },
    createWorktree: async (c: IdContext) => {
      // ここでは root ペインと名前まで。エージェントの起動はクライアントが後から頼む。
      const body = await c.req.json().catch(() => null);
      const request = parseWorktreeBody(body);
      if (!request.ok) return c.json({ error: request.error }, request.status);

      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);
      // Herdr は未登録でも cwd から起点を解決する。linked worktree からの作成は受け付けない。
      if (workspace.worktree === null) return c.json({ error: "not_git_worktree" }, 409);
      if (workspace.worktree.isLinkedWorktree) {
        return c.json({ error: "linked_worktree_source" }, 409);
      }

      try {
        const result = await createWorktree(worktrees, panes, workspaceId, request.value);
        if (!result.ok) {
          // ワークツリーと root シェルは残っている。クライアントは理由を見せて閉じるだけにする。
          return c.json(
            { error: result.error, workspaceId: result.workspaceId, paneId: result.paneId },
            502,
          );
        }
        // 取り直しは workspace.created / pane.created に任せる。
        return c.json({ workspaceId: result.workspaceId, paneId: result.paneId });
      } catch (error) {
        return herdrFailure(c, error, WORKTREE_FAILURE_STATUS);
      }
    },
    // ツリーで選んだフォルダを作業ディレクトリにしたスペースを作る。id は起点のペインで、
    // パスはそのペインのツリーの根から解く。
    createSpace: async (c: IdContext) => {
      const body = await c.req.json().catch(() => null);
      const request = parseCreateSpaceBody(body);
      if (!request.ok) return c.json({ error: request.error }, request.status);

      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;
      const root = store.workspaceRoot(paneId);
      if (root === null) return c.json({ error: "no_checkout" }, 404);
      // ツリーの一覧と同じ規則で解く。根の外・`.git`・ディレクトリでないものは作らない。
      const directory = await resolveTreeDirectory({ root, path: request.value.path });
      if (directory === null) return c.json({ error: "not_found" }, 404);

      try {
        const result = await createSpace(workspaces, panes, {
          cwd: directory.real,
          label: basename(directory.base),
          name: request.value.name,
        });
        if (!result.ok) {
          // スペースと root シェルは残っている。クライアントは起動へ進む。
          return c.json(
            { error: result.error, workspaceId: result.workspaceId, paneId: result.paneId },
            502,
          );
        }
        // 取り直しは workspace.created / pane.created に任せる。
        return c.json({ workspaceId: result.workspaceId, paneId: result.paneId });
      } catch (error) {
        return herdrFailure(c, error);
      }
    },
    removeWorktree: async (c: IdContext) => {
      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);
      // worktree.remove は Herdr が管理する linked worktree 専用。本体（linked でない）も拒否する。
      if (workspace.worktree?.managed !== true || !workspace.worktree.isLinkedWorktree) {
        return c.json({ error: "not_linked_worktree" }, 409);
      }

      try {
        await worktrees.remove({ workspaceId });
        // スペースが消えるのは Herdr のイベント（workspace.closed）に任せる。
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof HerdrError) {
          if (error.code === "not_linked_worktree") {
            return c.json({ error: error.code }, 409);
          }
          if (error.code === "workspace_not_found" || error.code === "worktree_not_found") {
            return c.json({ error: "workspace_not_found" }, 404);
          }
        }
        return c.json({ error: "herdr_unavailable" }, 502);
      }
    },
    close: async (c: IdContext) => {
      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      const { state } = resolved;
      pruneClosingSpaces(state);

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

      // 最後の 1 つは閉じない。Herdr が管理する linked worktree は worktree.remove に任せる。
      if (workspace.worktree?.managed === true && workspace.worktree.isLinkedWorktree) {
        return c.json({ error: "not_closable_space" }, 409);
      }
      if (closingSpaces.has(workspaceId)) return c.json({ error: "not_closable_space" }, 409);
      const remaining = state.workspaces.filter((item) => !closingSpaces.has(item.id));
      if (remaining.length < 2) return c.json({ error: "not_closable_space" }, 409);

      // close が返る前に次の要求が残りの数を通らないよう、呼ぶ前に印を付ける。
      closingSpaces.add(workspaceId);
      try {
        await workspaces.close(workspaceId);
        // 応答は待たせない。状態が届くまでの間は closing に残し、後続の close を
        // 409 にする。届いた id は次の要求の prune で外れる。
        void store.refresh().catch(() => {});
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof HerdrError && error.code === "workspace_not_found") {
          // 既に閉じている。状態が届くまでは、他のスペースを閉じさせない。
          void store.refresh().catch(() => {});
        } else {
          releaseClosingSpace(workspaceId);
        }
        return herdrFailure(c, error, CLOSE_SPACE_FAILURE_STATUS);
      }
    },
  };
}
