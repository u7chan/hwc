import { expect, test } from "bun:test";
import { HerdrError } from "./herdr/socket";
import {
  createTestApp,
  duplicateState,
  hostWorktreeState,
  threeWorkspaces,
} from "./app.test-helpers";

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// 3 つの対応表は、共通の workspace_not_found / invalid と、経路ごとのコードでできている。
// 畳んだあとも同じ入力で同じ status と error を返すことを、経路ごとに確かめる。
test.each([
  ["worktree_create_failed", 502, "worktree_create_failed"],
  ["worktree_open_failed", 502, "worktree_open_failed"],
  ["worktree_operation_in_progress", 409, "worktree_operation_in_progress"],
  ["linked_worktree_source", 409, "linked_worktree_source"],
  ["not_git_worktree", 409, "not_git_worktree"],
  ["workspace_not_found", 404, "workspace_not_found"],
  ["invalid_params", 400, "invalid_request"],
  ["invalid_request", 400, "invalid_request"],
  ["unknown_method", 502, "herdr_unavailable"],
] as const)("create-worktree answers %s", async (code, status, error) => {
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => {
        throw new HerdrError(code, "cannot create");
      },
    },
  });

  const response = await app.request("/api/workspaces/w1/create-worktree", post({}));

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});

test.each([
  ["workspace_not_found", 404, "workspace_not_found"],
  ["invalid_params", 400, "invalid_request"],
  ["invalid_request", 400, "invalid_request"],
  ["herdr_internal", 502, "herdr_unavailable"],
  ["unknown_method", 502, "herdr_unavailable"],
] as const)("move answers %s", async (code, status, error) => {
  const { app } = createTestApp({
    state: threeWorkspaces,
    workspaces: {
      moveBlock: async () => {
        throw new HerdrError(code, "cannot move");
      },
    },
  });

  const response = await app.request(
    "/api/workspaces/move",
    post({ workspaceIds: ["w3"], beforeWorkspaceId: "w1" }),
  );

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});

test.each([
  ["workspace_not_found", 404, "workspace_not_found"],
  ["workspace_group_close_required", 409, "workspace_group_close_required"],
  ["invalid_params", 400, "invalid_request"],
  ["invalid_request", 400, "invalid_request"],
  ["workspace_close_failed", 502, "herdr_unavailable"],
  ["unknown_method", 502, "herdr_unavailable"],
] as const)("close answers %s", async (code, status, error) => {
  const { app } = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async () => {
        throw new HerdrError(code, "cannot close");
      },
    },
  });

  const response = await app.request("/api/workspaces/w2/close", post({}));

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});

// 対応表は素のオブジェクトなので、表引きが Object.prototype を拾うと status が関数になる。
// その場合 status が無効値になり、未知のコードが 502 ではなく 200 で返る。close は 2xx を
// 成功として扱うため、失敗が成功として画面に出てしまう。
test("answers herdr_unavailable for a code named after Object.prototype", async () => {
  const unknown = (code: string) => new HerdrError(code, "cannot do it");

  const worktreeApp = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => {
        throw unknown("toString");
      },
    },
  });
  const worktree = await worktreeApp.app.request("/api/workspaces/w1/create-worktree", post({}));
  expect(worktree.status).toBe(502);
  expect(await worktree.json()).toEqual({ error: "herdr_unavailable" });

  const moveApp = createTestApp({
    state: threeWorkspaces,
    workspaces: {
      moveBlock: async () => {
        throw unknown("constructor");
      },
    },
  });
  const move = await moveApp.app.request(
    "/api/workspaces/move",
    post({ workspaceIds: ["w3"], beforeWorkspaceId: "w1" }),
  );
  expect(move.status).toBe(502);
  expect(await move.json()).toEqual({ error: "herdr_unavailable" });

  const closeApp = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async () => {
        throw unknown("valueOf");
      },
    },
  });
  const close = await closeApp.app.request("/api/workspaces/w2/close", post({}));
  expect(close.status).toBe(502);
  expect(await close.json()).toEqual({ error: "herdr_unavailable" });
});
