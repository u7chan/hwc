import { expect, test } from "bun:test";
import { createApp } from "./app";
import type { ChatSnapshot } from "./chat/contract";
import { OpencodeServiceNotRunningError } from "./chat/opencode";
import type { PaneClient } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";
import type { AppState } from "./herdr/state";
import {
  pane,
  state,
  workingState,
  worktreeState,
  hostWorktreeState,
  unmanagedHostState,
  twoChatPanesState,
  sessionPath,
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

const fourPaneState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [
        {
          ...state.workspaces[0]!.tabs[0]!,
          panes: [
            pane,
            { ...pane, id: "w1:p2" },
            { ...pane, id: "w1:p3" },
            { ...pane, id: "w1:p4" },
          ],
        },
      ],
    },
  ],
};

function postSplit(app: ReturnType<typeof createApp>, paneId: string, body: unknown = {}) {
  return app.request(`/api/panes/${paneId}/split`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 新しいペインにモデルを指定して作るアプリ。作成先の w1:p2 は最初から状態にある。
function launchModelApp() {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes({ split: async () => ({ paneId: "w1:p2" }) }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });
  const split = () =>
    postSplit(app, "w1:p1", {
      agent: "pi",
      model: { provider: "example", id: "beam" },
      effort: "low",
    });
  return { app, split };
}

test.each(["pi", "codex", "opencode"] as const)(
  "GET /api/panes/:id/models lists %s candidates in the pane's directory",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      models: {
        efforts: async () => [],
        list: async (...args) => {
          seen.push(args);
          return [{ provider: "example", id: "beam" }];
        },
        startArgs: async () => {
          throw new Error("Reading must not create a session");
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [{ provider: "example", id: "beam" }] });
    expect(seen).toEqual([[agent, "/project"]]);
  },
);

test.each(["pi", "codex", "opencode"] as const)(
  "GET /api/panes/:id/efforts reads %s choices for the explicit model in the pane's directory",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      models: {
        list: async () => [],
        efforts: async (...args) => {
          seen.push(args);
          return ["eco", "max"];
        },
        startArgs: async () => {
          throw new Error("Reading must not create a session");
        },
      },
    });
    const query = new URLSearchParams({ agent, provider: "example", model: "@demo/beam" });
    const response = await app.request(`/api/panes/w1:p1/efforts?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ efforts: ["eco", "max"] });
    expect(seen).toEqual([[agent, { provider: "example", id: "@demo/beam" }, "/project"]]);
  },
);

test.each([
  "agent=claude&provider=example&model=beam",
  "agent=pi",
  "agent=pi&provider=example&model=--help",
])("GET /api/panes/:id/efforts rejects an invalid or missing model: %s", async (query) => {
  const { app } = createTestApp();
  expect((await app.request(`/api/panes/w1:p1/efforts?${query}`)).status).toBe(400);
});

test("GET /api/panes/:id/efforts preserves unsupported choices and hides upstream errors", async () => {
  let fail = false;
  const { app } = createTestApp({
    models: {
      list: async () => [],
      efforts: async () => {
        if (fail) throw new Error("/private/path: credentials");
        return [];
      },
      startArgs: async () => [],
    },
  });
  const path = "/api/panes/w1:p1/efforts?agent=pi&provider=example&model=beam";
  const unsupported = await app.request(path);
  expect(unsupported.status).toBe(200);
  expect(await unsupported.json()).toEqual({ efforts: [] });
  fail = true;
  const unavailable = await app.request(path);
  expect(unavailable.status).toBe(502);
  expect(await unavailable.json()).toEqual({ error: "efforts_unavailable" });
});

test("GET /api/panes/:id/efforts requires an existing pane, a snapshot, and a model client", async () => {
  const { app } = createTestApp();
  const query = "?agent=pi&provider=example&model=beam";
  expect((await app.request(`/api/panes/w1:p9/efforts${query}`)).status).toBe(404);
  expect((await app.request(`/api/panes/w1:p1/efforts${query}`)).status).toBe(502);
  const unavailable = createTestApp({ state: null, storeFailure: new Error("unavailable") }).app;
  expect((await unavailable.request(`/api/panes/w1:p1/efforts${query}`)).status).toBe(502);
});

test.each(["pi", "codex", "opencode"] as const)(
  "POST /api/panes/:id/split passes the selected %s effort only to the new pane",
  async (kind) => {
    const model = { provider: "example", id: "beam" };
    const seen: unknown[] = [];
    const { app } = createTestApp({
      panes: {
        split: async () => ({ paneId: "w1:p2" }),
        startAgent: async (options) => {
          seen.push(options);
        },
      },
      models: {
        list: async () => [],
        efforts: async () => [],
        startArgs: async (...args) => {
          expect(args).toEqual([kind, model, "/project", "max"]);
          return ["fixture-args"];
        },
      },
    });
    const response = await postSplit(app, "w1:p1", { agent: kind, model, effort: "max" });
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p2",
        kind,
        name: "hwc-w1-p2",
        args: [...(kind === "codex" ? ["--no-daemon"] : []), "fixture-args"],
      },
    ]);
  },
);

test("POST /api/panes/:id/split rejects effort without a model before creating anything", async () => {
  const { app } = createTestApp({
    panes: {
      split: async () => {
        throw new Error("Must not split");
      },
    },
  });
  expect((await postSplit(app, "w1:p1", { agent: "pi", effort: "high" })).status).toBe(400);
});

test.each(["claude", "unknown", ""])(
  "GET /api/panes/:id/models rejects unsupported agent %s",
  async (agent) => {
    const { app } = createTestApp();
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(400);
  },
);

test("GET /api/panes/:id/models identifies an OpenCode service that is not running", async () => {
  const { app } = createTestApp({
    models: {
      efforts: async () => [],
      list: async () => {
        throw new OpencodeServiceNotRunningError();
      },
      startArgs: async () => [],
    },
  });
  const response = await app.request("/api/panes/w1:p1/models?agent=opencode");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "opencode_not_running" });
});

test.each(["pi", "opencode"])(
  "GET /api/panes/:id/models does not expose upstream %s errors or paths",
  async (agent) => {
    const { app } = createTestApp({
      models: {
        efforts: async () => [],
        list: async () => {
          throw new Error("/private/path: credential failure");
        },
        startArgs: async () => [],
      },
    });
    const response = await app.request(`/api/panes/w1:p1/models?agent=${agent}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "models_unavailable" });
  },
);

test("GET /api/panes/:id/models requires an existing pane and a readable snapshot", async () => {
  const missing = createTestApp().app;
  expect((await missing.request("/api/panes/w1:p9/models?agent=pi")).status).toBe(404);
  const unavailable = createTestApp({ state: null, storeFailure: new Error("unavailable") }).app;
  expect((await unavailable.request("/api/panes/w1:p1/models?agent=pi")).status).toBe(502);
});

test.each(["pi", "codex"] as const)(
  "POST /api/panes/:id/split passes the chosen %s model to startup preparation",
  async (kind) => {
    const seen: unknown[] = [];
    const model = { provider: "example", id: "beam" };
    const args = ["--model", kind === "pi" ? "example/beam" : "beam"];
    const { app } = createTestApp({
      panes: {
        split: async () => ({ paneId: "w1:p2" }),
        startAgent: async (options) => {
          seen.push(options);
        },
      },
      models: {
        efforts: async () => [],
        list: async () => [model],
        startArgs: async (agent, selected, directory) => {
          expect({ agent, selected, directory }).toEqual({
            agent: kind,
            selected: model,
            directory: "/project",
          });
          return args;
        },
      },
    });
    const response = await postSplit(app, "w1:p1", { agent: kind, model });
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p2",
        kind,
        name: "hwc-w1-p2",
        args: kind === "codex" ? ["--no-daemon", ...args] : args,
      },
    ]);
  },
);

test("POST /api/panes/:id/split shows the chosen model until the session records one", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  let recorded: ChatSnapshot = emptyChat;
  const app = createApp({
    store,
    chat: createFakeChat({
      snapshot: async (path) => (path === otherSessionPath ? recorded : emptyChat),
    }),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes({ split: async () => ({ paneId: "w1:p2" }) }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
    effort: "low",
  });
  expect(split.status).toBe(200);

  const filled = await app.request("/api/panes/w1:p2/chat");
  expect(await filled.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: "low",
  });

  // 最初のメッセージでセッションにモデルが載ったら、以降はセッションの値だけを出す。
  recorded = { ...emptyChat, etag: "etag-2", model: "beam-mini" };
  const fromSession = await app.request("/api/panes/w1:p2/chat");
  expect(await fromSession.json()).toEqual(recorded);
  recorded = emptyChat;
  const after = await app.request("/api/panes/w1:p2/chat");
  expect(await after.json()).toEqual(emptyChat);
});

test("a client that read the pane before the split is not pinned to the old snapshot", async () => {
  const { app, split } = launchModelApp();

  // 分割表示では、作成したペインの会話が split の応答より先に読まれることがある。
  const before = await app.request("/api/panes/w1:p2/chat");
  expect(await before.json()).toEqual(emptyChat);
  expect(before.headers.get("etag")).toBe(`"${emptyChat.etag}"`);

  expect((await split()).status).toBe(200);

  const after = await app.request("/api/panes/w1:p2/chat", {
    headers: { "if-none-match": `"${emptyChat.etag}"` },
  });
  expect(after.status).toBe(200);
  const filledEtag = "etag-1+launch";
  expect(await after.json()).toEqual({
    ...emptyChat,
    etag: filledEtag,
    model: "beam",
    effort: "low",
  });

  // 補完が続く間は同じ etag を返し、一致する If-None-Match に 304 を返す。
  const unchanged = await app.request("/api/panes/w1:p2/chat", {
    headers: { "if-none-match": `"${filledEtag}"` },
  });
  expect(unchanged.status).toBe(304);
});

test("POST /api/panes/:id/split shows the chosen model even when the rename fails", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes({
      split: async () => ({ paneId: "w1:p2" }),
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w1:p2");
      },
    }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    name: "実装",
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(split.status).toBe(502);
  expect(await split.json()).toEqual({ error: "pane_rename_failed", paneId: "w1:p2" });

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: null,
  });
});

test("POST /api/panes/:id/split does not show a model when the agent cannot start", async () => {
  const store = createFakeStore(twoChatPanesState);
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes({
      split: async () => ({ paneId: "w1:p2" }),
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "pi is not installed");
      },
    }),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });

  const split = await postSplit(app, "w1:p1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
  });
  expect(split.status).toBe(502);

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual(emptyChat);
});

test("closing a pane drops the model chosen at startup", async () => {
  const { app, split } = launchModelApp();
  expect((await split()).status).toBe(200);

  const close = await app.request("/api/panes/w1:p2/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(close.status).toBe(200);

  const response = await app.request("/api/panes/w1:p2/chat");
  expect(await response.json()).toEqual(emptyChat);
});

function postAgent(
  app: ReturnType<typeof createApp>,
  paneId: string,
  body: unknown = { agent: "pi" },
) {
  return app.request(`/api/panes/${paneId}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/panes/:id/agent starts in the existing shell pane without splitting or renaming", async () => {
  const seen: unknown[] = [];
  const { app, store } = createTestApp({
    panes: {
      split: async () => {
        throw new Error("Must not split");
      },
      rename: async () => {
        throw new Error("Must not rename");
      },
      startAgent: async (options) => {
        seen.push(options);
      },
    },
  });

  const response = await postAgent(app, "w1:p1");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([
    {
      paneId: "w1:p1",
      kind: "pi",
      name: expect.stringMatching(/^hwc-w1-p1-[0-9a-z]{4}$/),
      waitForShell: false,
    },
  ]);
  // 起動したかは Herdr の pane.updated で状態が動く。ここで取り直さない。
  expect(store.refreshCount()).toBe(0);
});

test("POST /api/panes/:id/agent refuses a pane that already has an agent", async () => {
  const calls: string[] = [];
  const { app } = createTestApp({
    state: workingState,
    panes: {
      startAgent: async () => {
        calls.push("start");
      },
    },
  });

  const response = await postAgent(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_not_shell" });
  expect(calls).toEqual([]);
});

test.each([
  {},
  { agent: null },
  { agent: "gemini" },
  { agent: "claude", model: { provider: "example", id: "beam" } },
  { agent: "pi", effort: "high" },
])("POST /api/panes/:id/agent rejects an invalid body: %j", async (body) => {
  const { app } = createTestApp({
    panes: {
      startAgent: async () => {
        throw new Error("Must not start");
      },
    },
  });

  expect((await postAgent(app, "w1:p1", body)).status).toBe(400);
});

test("POST /api/panes/:id/agent requires an existing pane and a readable snapshot", async () => {
  const missing = createTestApp().app;
  expect((await postAgent(missing, "w1:p9")).status).toBe(404);

  const unavailable = createTestApp({ state: null, storeFailure: new Error("unavailable") }).app;
  expect((await postAgent(unavailable, "w1:p1")).status).toBe(502);
});

test("POST /api/panes/:id/agent reports a running foreground command as busy", async () => {
  const { app } = createTestApp({
    panes: {
      startAgent: async () => {
        throw new HerdrError("agent_pane_busy", "foreground command is running");
      },
    },
  });

  const response = await postAgent(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_busy" });
});

test("POST /api/panes/:id/agent keeps the pane and reports a failed startup", async () => {
  const { app } = createTestApp({
    panes: {
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "pi is not installed");
      },
    },
  });

  const response = await postAgent(app, "w1:p1");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "agent_start_failed" });
});

test("POST /api/panes/:id/agent passes the chosen model to startup preparation", async () => {
  const seen: unknown[] = [];
  const model = { provider: "example", id: "beam" };
  const { app } = createTestApp({
    panes: {
      startAgent: async (options) => {
        seen.push(options);
      },
    },
    models: {
      list: async () => [model],
      efforts: async () => [],
      startArgs: async (agent, selected, directory, effort) => {
        expect({ agent, selected, directory, effort }).toEqual({
          agent: "codex",
          selected: model,
          directory: "/project",
          effort: "low",
        });
        return ["--model", "beam"];
      },
    },
  });

  const response = await postAgent(app, "w1:p1", { agent: "codex", model, effort: "low" });

  expect(response.status).toBe(200);
  expect(seen).toEqual([
    {
      paneId: "w1:p1",
      kind: "codex",
      name: expect.stringMatching(/^hwc-w1-p1-[0-9a-z]{4}$/),
      waitForShell: false,
      args: ["--no-daemon", "--model", "beam"],
    },
  ]);
});

test("POST /api/panes/:id/agent shows the chosen model until the session records one", async () => {
  const store = createFakeStore(state);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  const app = createApp({
    store,
    chat: createFakeChat(),
    worktrees: createFakeWorktrees(),
    workspaces: createFakeWorkspaces(),
    panes: createFakePanes(),
    models: {
      list: async () => [],
      efforts: async () => [],
      startArgs: async () => ["--model", "example/beam"],
    },
  });
  const response = await postAgent(app, "w1:p1", {
    agent: "pi",
    model: { provider: "example", id: "beam" },
    effort: "low",
  });
  expect(response.status).toBe(200);

  // 起動が終わると Herdr の pane.updated で、そのペインは会話を持つ。
  const [workspace] = state.workspaces;
  const [tab] = workspace!.tabs;
  store.push(
    {
      ...state,
      workspaces: [
        {
          ...workspace!,
          tabs: [{ ...tab!, panes: [{ ...pane, agent: "pi", chat: true }] }],
        },
      ],
    },
    true,
  );

  const chat = await app.request("/api/panes/w1:p1/chat");
  expect(await chat.json()).toEqual({
    ...emptyChat,
    etag: "etag-1+launch",
    model: "beam",
    effort: "low",
  });
});

test("POST /api/panes/:id/split rejects a Claude model override before creating anything", async () => {
  const { app } = createTestApp({
    panes: {
      split: async () => {
        throw new Error("Must not split");
      },
    },
  });
  const response = await postSplit(app, "w1:p1", {
    agent: "claude",
    model: { provider: "example", id: "beam" },
  });
  expect(response.status).toBe(400);
});

test("POST /api/panes/:id/split validates the body before loading a snapshot", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
  });
  const response = await postSplit(app, "w1:p1", { name: 42 });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "name must be a string" });
});

test("POST /api/panes/:id/split splits the largest cell toward the target aspect", async () => {
  const seenLayout: unknown[] = [];
  const seenSplit: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      layout: async (options) => {
        seenLayout.push(options);
        return {
          cells: [
            { paneId: "w1:p1", width: 100, height: 47 },
            { paneId: "w1:p2", width: 160, height: 47 },
          ],
        };
      },
      split: async (options) => {
        seenSplit.push(options);
        return { paneId: "w1:p3" };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ paneId: "w1:p3" });
  expect(seenLayout).toEqual([{ paneId: "w1:p1" }]);
  // 一番大きいセルは w1:p2。160x47 は右に割ると 1.63 から 0.82 になり、下より目標 1.4 に近い。
  expect(seenSplit).toEqual([{ paneId: "w1:p2", direction: "right", ratio: 0.5 }]);
});

test("POST /api/panes/:id/split stops at four panes in the tab", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: fourPaneState,
    panes: {
      layout: async (options) => {
        seen.push(options);
        return { cells: [] };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_limit" });
  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/split stops when the layout already has four panes", async () => {
  const seenSplit: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      layout: async () => ({
        cells: [
          { paneId: "w1:p1", width: 60, height: 47 },
          { paneId: "w1:p2", width: 60, height: 47 },
          { paneId: "w1:p3", width: 60, height: 47 },
          { paneId: "w1:p4", width: 60, height: 47 },
        ],
      }),
      split: async (options) => {
        seenSplit.push(options);
        return { paneId: "w1:p5" };
      },
    },
  });
  const response = await postSplit(app, "w1:p1");

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "pane_limit" });
  expect(seenSplit).toEqual([]);
});

test("POST /api/panes/:id/split gives the creation the trimmed name and the agent", async () => {
  // 起動順や Herdr 名の作り方は create-pane.test.ts が見る。ここはルートが
  // parseSplitBody の結果を渡していることだけを見る。
  const seenStart: unknown[] = [];
  const seenRename: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      startAgent: async (options) => {
        seenStart.push(options);
      },
      rename: async (options) => {
        seenRename.push(options);
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: " 実装 ", agent: "pi" });

  expect(response.status).toBe(200);
  expect(seenStart).toMatchObject([{ paneId: "w1:p3", kind: "pi" }]);
  expect(seenRename).toEqual([{ paneId: "w1:p3", label: "実装" }]);
});

test("POST /api/panes/:id/split keeps the pane when the agent cannot start", async () => {
  const seenRename: unknown[] = [];
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      startAgent: async () => {
        throw new HerdrError("agent_spawn_failed", "codex is not installed");
      },
      rename: async (options) => {
        seenRename.push(options);
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: "実装", agent: "codex" });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "agent_start_failed", paneId: "w1:p3" });
  // 起動に失敗しても、作成済みのペインには名前を付けておく。
  expect(seenRename).toEqual([{ paneId: "w1:p3", label: "実装" }]);
});

test("POST /api/panes/:id/split reports a rename failure after the pane is created", async () => {
  const { app } = createTestApp({
    state: twoChatPanesState,
    panes: {
      split: async () => ({ paneId: "w1:p3" }),
      rename: async () => {
        throw new HerdrError("pane_not_found", "no pane w1:p3");
      },
    },
  });
  const response = await postSplit(app, "w1:p1", { name: "実装", agent: null });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "pane_rename_failed", paneId: "w1:p3" });
});

test("POST /api/panes/:id/split rejects a body without an object", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      split: async (options) => {
        seen.push(options);
        return { paneId: "w1:p2" };
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/split", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be an object" });
  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/split rejects an unknown agent or an overlong name", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      split: async (options) => {
        seen.push(options);
        return { paneId: "w1:p2" };
      },
    },
  });

  for (const body of [{ agent: "gemini" }, { name: 42 }, { name: "x".repeat(81) }]) {
    const response = await postSplit(app, "w1:p1", body);
    expect(response.status).toBe(400);
  }
  expect(seen).toEqual([]);
});
