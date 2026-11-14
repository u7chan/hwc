import { expect, test } from "bun:test";
import { createApp } from "./app";
import { HerdrError } from "./herdr/socket";
import {
  state,
  worktreeState,
  hostWorktreeState,
  unmanagedHostState,
  fourPaneState,
  createTestApp,
} from "./app.test-helpers";

function postCreateWorktree(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  body: unknown = {},
) {
  return app.request(`/api/workspaces/${workspaceId}/create-worktree`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/workspaces/:id/create-worktree creates the worktree and names the root pane", async () => {
  const created: unknown[] = [];
  const renamed: unknown[] = [];
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async (options) => {
        created.push(options);
        return { workspaceId: "w2", paneId: "w2:p1" };
      },
    },
    panes: {
      startAgent: async () => {
        throw new Error("Must not start the agent in the creation request");
      },
      rename: async (options) => {
        renamed.push(options);
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { name: " 実装 " });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceId: "w2", paneId: "w2:p1" });
  expect(created).toEqual([{ workspaceId: "w1" }]);
  expect(renamed).toEqual([{ paneId: "w2:p1", label: "実装" }]);
});

test("create-worktree does not apply the split tab limit", async () => {
  const { app } = createTestApp({
    state: {
      ...fourPaneState,
      workspaces: [
        {
          ...fourPaneState.workspaces[0]!,
          worktree: {
            repoName: "hwc",
            repoRoot: "/project",
            checkoutPath: "/project",
            isLinkedWorktree: false,
            managed: true,
          },
        },
      ],
    },
    worktrees: {
      create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }),
    },
    panes: {
      layout: async () => {
        throw new Error("Must not read the layout");
      },
      split: async () => {
        throw new Error("Must not split");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1");

  // 4 枚上限はタブ単位。ワークツリー作成は新しいタブを Herdr が作るので、枚数を見ない。
  expect(response.status).toBe(200);
});

test("create-worktree requires application/json", async () => {
  const { app } = createTestApp({ state: hostWorktreeState });
  const response = await app.request("/api/workspaces/w1/create-worktree", { method: "POST" });

  expect(response.status).toBe(415);
});

test("create-worktree validates the body before loading a snapshot", async () => {
  const { app } = createTestApp({ state: null, storeFailure: new Error("socket closed") });
  const response = await postCreateWorktree(app, "w1", { name: 42 });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "name must be a string" });
});

test("create-worktree reports a workspace that is no longer listed", async () => {
  const { app } = createTestApp({ state: hostWorktreeState });
  const response = await postCreateWorktree(app, "w9");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "workspace_not_found" });
});

test("create-worktree refuses a workspace that is not in git", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state,
    worktrees: {
      create: async () => {
        seen.push("create");
        return { workspaceId: "w2", paneId: "w2:p1" };
      },
    },
  });
  const response = await postCreateWorktree(app, "w1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_git_worktree" });
  expect(seen).toEqual([]);
});

test("create-worktree refuses a git checkout that herdr does not manage", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: unmanagedHostState,
    worktrees: {
      create: async () => {
        seen.push("create");
        return { workspaceId: "w2", paneId: "w2:p1" };
      },
    },
  });
  const response = await postCreateWorktree(app, "w1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_git_worktree" });
  expect(seen).toEqual([]);
});

test("create-worktree refuses a linked worktree as the source", async () => {
  const seen: string[] = [];
  const { app } = createTestApp({
    state: worktreeState,
    worktrees: {
      create: async () => {
        seen.push("create");
        return { workspaceId: "w2", paneId: "w2:p1" };
      },
    },
  });
  const response = await postCreateWorktree(app, "w1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "linked_worktree_source" });
  expect(seen).toEqual([]);
});

// 作成できたか・再試行できるかはコードで決まる。ソケットや parser の失敗は結果不明になる。
test.each([
  ["worktree_create_failed", 502],
  ["worktree_open_failed", 502],
  ["worktree_operation_in_progress", 409],
  ["linked_worktree_source", 409],
  ["not_git_worktree", 409],
  ["workspace_not_found", 404],
  ["invalid_params", 400],
] as const)("create-worktree maps %s", async (code, status) => {
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => {
        throw new HerdrError(code, "cannot create");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1");

  expect(response.status).toBe(status);
});

test.each([
  [new Error("worktree.create: timed out after 60000ms"), "herdr_unavailable"],
  [new Error("worktree.create: invalid JSON from Herdr"), "herdr_unavailable"],
  [new HerdrError("unknown_method", "nope"), "herdr_unavailable"],
] as const)(
  "create-worktree keeps %s from looking like a creation failure",
  async (error, code) => {
    const { app } = createTestApp({
      state: hostWorktreeState,
      worktrees: {
        create: async () => {
          throw error;
        },
      },
    });
    const response = await postCreateWorktree(app, "w1");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: code });
  },
);

test("create-worktree keeps the worktree and reports the failed rename", async () => {
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }),
    },
    panes: {
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w2:p1");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { name: "実装" });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "pane_rename_failed",
    workspaceId: "w2",
    paneId: "w2:p1",
  });
});
