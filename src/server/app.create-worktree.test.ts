import { expect, test } from "bun:test";
import { createApp } from "./app";
import type { PaneClient } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";
import type { AppState } from "./herdr/state";
import {
  state,
  worktreeState,
  hostWorktreeState,
  unmanagedHostState,
  twoChatPanesState,
  fourPaneState,
  otherSessionPath,
  createFakeStore,
  createFakeChat,
  emptyChat,
  createFakePanes,
  createFakeWorktrees,
  createFakeWorkspaces,
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

// 新しい root pane（w1:p2）を状態に持つアプリ。起動したペインの会話を読めるようにする。
function createWorktreeApp(options: { panes?: Partial<PaneClient> } = {}) {
  const hostState: AppState = {
    ...twoChatPanesState,
    workspaces: [
      {
        ...twoChatPanesState.workspaces[0]!,
        worktree: {
          repoName: "hwc",
          repoRoot: "/project",
          checkoutPath: "/project",
          isLinkedWorktree: false,
          managed: true,
        },
      },
    ],
  };
  const store = createFakeStore(hostState);
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees({
      create: async () => ({ workspaceId: "w2", paneId: "w1:p2" }),
    }),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes({
      startAgent: async () => {},
      rename: async () => {},
      ...options.panes,
    }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });
  return app;
}

test("POST /api/workspaces/:id/create-worktree starts the agent in the new root pane", async () => {
  const seen: unknown[] = [];
  const renamed: unknown[] = [];
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async (options) => {
        seen.push(options);
        return { workspaceId: "w2", paneId: "w2:p1" };
      },
    },
    panes: {
      startAgent: async (options) => {
        seen.push(options);
      },
      rename: async (options) => {
        renamed.push(options);
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { name: " 実装 ", agent: "pi" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceId: "w2", paneId: "w2:p1" });
  expect(seen).toEqual([{ workspaceId: "w1" }, { paneId: "w2:p1", kind: "pi", name: "hwc-w2-p1" }]);
  expect(renamed).toEqual([{ paneId: "w2:p1", label: "実装" }]);
});

test("create-worktree does not apply the split tab limit", async () => {
  const seen: unknown[] = [];
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
      startAgent: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { agent: "pi" });

  // 4 枚上限はタブ単位。ワークツリー作成は新しいタブを Herdr が作るので、枚数を見ない。
  expect(response.status).toBe(200);
  expect(seen).toMatchObject([{ paneId: "w2:p1", kind: "pi" }]);
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

test("create-worktree keeps the worktree and reports the failed agent start", async () => {
  const renamed: unknown[] = [];
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }),
    },
    panes: {
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "pi is not installed");
      },
      rename: async (options) => {
        renamed.push(options);
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { name: "実装", agent: "pi" });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "agent_start_failed",
    workspaceId: "w2",
    paneId: "w2:p1",
  });
  // 名前はまだ付ける。ワークツリーと root シェルは残す。
  expect(renamed).toEqual([{ paneId: "w2:p1", label: "実装" }]);
});

test("create-worktree counts an agent waiting at its prompt as a created pane", async () => {
  const { app } = createTestApp({
    state: hostWorktreeState,
    worktrees: {
      create: async () => ({ workspaceId: "w2", paneId: "w2:p1" }),
    },
    panes: {
      startAgent: async () => {
        throw new HerdrError("agent_not_ready", "waiting for trust");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", { agent: "claude" });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceId: "w2", paneId: "w2:p1" });
});

test("create-worktree shows the chosen model until the session records one", async () => {
  const app = createWorktreeApp();
  const response = await postCreateWorktree(app, "w1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
    effort: "low",
  });
  expect(response.status).toBe(200);

  const chat = await app.request("/api/panes/w1:p2/chat");
  expect(await chat.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: "low",
  });
});

test("create-worktree shows the chosen model even when the rename fails", async () => {
  const app = createWorktreeApp({
    panes: {
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w1:p2");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", {
    name: "実装",
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "pane_rename_failed",
    workspaceId: "w2",
    paneId: "w1:p2",
  });

  const chat = await app.request("/api/panes/w1:p2/chat");
  expect(await chat.json()).toEqual({ ...emptyChat, etag: "etag-1+launch", model: "beam" });
});

test("create-worktree does not show a model when the agent cannot start", async () => {
  const app = createWorktreeApp({
    panes: {
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "pi is not installed");
      },
    },
  });
  const response = await postCreateWorktree(app, "w1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(response.status).toBe(502);

  const chat = await app.request("/api/panes/w1:p2/chat");
  expect(await chat.json()).toEqual(emptyChat);
});
