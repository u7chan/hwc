import { createWorktree } from "../create-worktree";
import { parseSplitBody } from "../herdr/panes";
import { parseMoveWorkspacesBody } from "../herdr/workspaces";
import { placeOf } from "../../shared/place";
import { HerdrError } from "../herdr/socket";
import type { AppContext, IdContext, PlainContext } from "./context";

export function createWorkspacesHandlers(ctx: AppContext) {
  const {
    store,
    panes,
    worktrees,
    workspaces,
    models,
    pullRequests,
    git,
    restartSettings,
    current,
    launchModels,
    worktreeFailure,
    workspaceFailure,
    closeSpaceFailure,
    scheduleRestart,
    closingSpaces,
    releaseClosingSpace,
    pruneClosingSpaces,
  } = ctx;

  return {
    pullRequest: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
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
      const pullRequest = await pullRequests({ checkoutPath, branch, refresh }).catch(() => null);
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

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

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

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

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
        return workspaceFailure(c, error);
      }

      // イベントでも取り直すが、応答と SSE の前後で古い順に戻って見えるのを避ける。
      await store.refresh().catch(() => {});
      return c.json({ ok: true });
    },
    createWorktree: async (c: IdContext) => {
      // 作成後のエージェント起動まで同じ指定を使う。body 無しは不正。
      const body = await c.req.json().catch(() => null);
      const request = parseSplitBody(body);
      if (!request.ok) return c.json({ error: request.error }, request.status);

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);
      // 起点はリポジトリ本体に限る。Herdr が管理していないスペースも worktree.create を拒否する。
      if (workspace.worktree?.managed !== true) return c.json({ error: "not_git_worktree" }, 409);
      if (workspace.worktree.isLinkedWorktree) {
        return c.json({ error: "linked_worktree_source" }, 409);
      }

      try {
        const result = await createWorktree(worktrees, panes, workspaceId, request.value, models);
        // 分割 API と同じく、名前の付け直しに失敗してもエージェントは起動している。
        if ((result.ok || result.error === "pane_rename_failed") && request.value.model != null) {
          launchModels.remember(result.paneId, request.value.model, request.value.effort ?? null);
        }
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
        return worktreeFailure(c, error);
      }
    },
    removeWorktree: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

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
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      pruneClosingSpaces(state);

      const workspaceId = c.req.param("id");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace === undefined) return c.json({ error: "workspace_not_found" }, 404);

      // 閉じられるのは、同じ場所を指す Herdr が管理しないスペースが他にもあるときだけ。
      // managed: true のワークツリーは対象外（linked は worktree.remove、本体は閉じない）。
      const place = placeOf(workspace);
      if (place === null) return c.json({ error: "not_duplicate_space" }, 409);
      const closing = closingSpaces.get(place.key) ?? new Set<string>();
      const duplicates = state.workspaces.filter(
        (item) => !closing.has(item.id) && placeOf(item)?.key === place.key,
      );
      if (duplicates.length < 2) return c.json({ error: "not_duplicate_space" }, 409);

      // close が返る前に次の要求が重複チェックを通らないよう、呼ぶ前に印を付ける。
      closing.add(workspaceId);
      closingSpaces.set(place.key, closing);
      try {
        await workspaces.close(workspaceId);
        // 応答は待たせない。状態が届くまでの間は closing に残し、後続の close を
        // 409 にする。届いた id は次の要求の prune で外れる。
        void store.refresh().catch(() => {});
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof HerdrError && error.code === "workspace_not_found") {
          // 既に閉じている。状態が届くまでは、同じ場所の別スペースを閉じさせない。
          void store.refresh().catch(() => {});
        } else {
          releaseClosingSpace(place.key, workspaceId);
        }
        return closeSpaceFailure(c, error);
      }
    },
  };
}
