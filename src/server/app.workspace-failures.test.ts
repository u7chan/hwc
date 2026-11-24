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
