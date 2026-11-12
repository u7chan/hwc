import { expect, test } from "bun:test";
import { HerdrError } from "./herdr/socket";
import type { AppState } from "./herdr/state";
import {
  state,
  worktreeState,
  unmanagedLinkedState,
  duplicateState,
  unmanagedDuplicateState,
  createTestApp,
  waitFor,
} from "./app.test-helpers";

test("POST /api/workspaces/:id/remove-worktree deletes a linked checkout", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: worktreeState,
    worktrees: {
      remove: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ workspaceId: "w1" }]);
});

test("remove-worktree refuses a workspace that is not a linked checkout", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state,
    worktrees: {
      remove: async () => {
        seen.push("remove");
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_linked_worktree" });
  expect(seen).toEqual([]);
});

test("remove-worktree refuses a linked checkout that herdr does not manage", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: unmanagedLinkedState,
    worktrees: {
      remove: async () => {
        seen.push("remove");
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_linked_worktree" });
  expect(seen).toEqual([]);
});

test("remove-worktree requires application/json", async () => {
  const { app } = createTestApp({ state: worktreeState });
  const response = await app.request("/api/workspaces/w1/remove-worktree", { method: "POST" });

  expect(response.status).toBe(415);
});

test("remove-worktree reports a workspace that is no longer listed", async () => {
  const { app } = createTestApp({ state: worktreeState });
  const response = await app.request("/api/workspaces/w9/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

// 消えたチェックアウトは目的の状態に達している。それ以外の拒否は 409 で区別する。
test.each([
  ["not_linked_worktree", 409],
  ["workspace_not_found", 404],
  ["worktree_not_found", 404],
  ["worktree_remove_failed", 502],
] as const)("remove-worktree maps %s", async (code, status) => {
  const { app } = createTestApp({
    state: worktreeState,
    worktrees: {
      remove: async () => {
        throw new HerdrError(code, "cannot remove");
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/remove-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(status);
});

test("POST /api/workspaces/:id/close closes a duplicate native space", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });
  const response = await app.request("/api/workspaces/w2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual(["w2"]);
});

test("close accepts unmanaged checkout duplicates", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: unmanagedDuplicateState,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });
  const response = await app.request("/api/workspaces/w2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual(["w2"]);
});

test("close refuses a native space without a duplicate", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_duplicate_space" });
  expect(seen).toEqual([]);
});

test("close refuses the same path with a different label", async () => {
  const seen: string[] = [];
  const differentLabel: AppState = {
    ...duplicateState,
    workspaces: duplicateState.workspaces.map((workspace, index) => ({
      ...workspace,
      label: index === 0 ? "mypi" : "mypi review",
    })),
  };
  const { app } = createTestApp({
    state: differentLabel,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_duplicate_space" });
  expect(seen).toEqual([]);
});

test("close refuses a linked worktree", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: worktreeState,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });
  const response = await app.request("/api/workspaces/w1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_duplicate_space" });
  expect(seen).toEqual([]);
});

test("close requires application/json", async () => {
  const { app } = createTestApp({ state: duplicateState });
  const response = await app.request("/api/workspaces/w1/close", { method: "POST" });

  expect(response.status).toBe(415);
});

test("close reports a workspace that is no longer listed", async () => {
  const { app } = createTestApp({ state: duplicateState });
  const response = await app.request("/api/workspaces/w9/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

// 消えたスペースは目的の状態に達している。グループを閉じる要求は勝手に通さない。
test.each([
  ["workspace_not_found", 404],
  ["workspace_group_close_required", 409],
  ["invalid_params", 400],
  ["workspace_close_failed", 502],
] as const)("close maps %s", async (code, status) => {
  const { app } = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async () => {
        throw new HerdrError(code, "cannot close");
      },
    },
  });
  const response = await app.request("/api/workspaces/w2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(status);
});

test("close serializes concurrent requests for the same place", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const { app } = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
        await gate;
      },
    },
  });

  const first = app.request("/api/workspaces/w1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const second = app.request("/api/workspaces/w2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  await waitFor(() => seen.length === 1);
  await Bun.sleep(10);
  release();
  const [a, b] = await Promise.all([first, second]);

  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(seen).toHaveLength(1);
  const rejected = a.status === 409 ? a : b;
  expect(await rejected.json()).toEqual({ error: "not_duplicate_space" });
});

test("close keeps the guard while the state still shows the closed space", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: duplicateState,
    workspaces: {
      close: async (workspaceId) => {
        seen.push(workspaceId);
      },
    },
  });

  const first = await app.request("/api/workspaces/w1/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(first.status).toBe(200);

  // fake store の refresh は同じ重複状態を返す。状態が追いつくまで、残りを閉じさせない。
  const second = await app.request("/api/workspaces/w2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "not_duplicate_space" });
  expect(seen).toEqual(["w1"]);
});
