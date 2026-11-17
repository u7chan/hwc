import { expect, test } from "bun:test";
import { createApp } from "./app";
import type { ChatClient } from "./chat/pi";
import type { AppState } from "./herdr/state";
import type { PiDefaultsReader } from "./pi-defaults";
import {
  chatState,
  createFakeStore,
  createTestApp,
  emptyChat,
  otherSessionPath,
  sessionPath,
  state,
  twoChatPanesState,
  waitFor,
} from "./app.test-helpers";

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultModelApp(
  options: {
    state?: AppState;
    chat?: Partial<ChatClient>;
    load?: PiDefaultsReader;
  } = {},
) {
  const store = createFakeStore(options.state ?? twoChatPanesState);
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  store.setChatSource("w1:p2", { agent: "pi", path: otherSessionPath });
  const { app } = createTestApp({
    store,
    panes: { split: async () => ({ paneId: "w1:p2" }) },
    chat: options.chat,
    loadPiDefaults:
      options.load ??
      (async () => {
        return { model: "beam", effort: "high" };
      }),
  });
  return app;
}

test("a pi pane launched with its default model is resolved when the chat is shown", async () => {
  const directories: string[] = [];
  const app = defaultModelApp({
    load: async (directory) => {
      directories.push(directory);
      return { model: "beam", effort: "high" };
    },
  });

  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);

  const response = await app.request("/api/panes/w1:p2/default-model");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ model: "beam", effort: "high" });
  expect(directories).toEqual(["/project"]);

  // 解決した値は、同じペインの次の表示で読み直さない。
  await app.request("/api/panes/w1:p2/default-model");
  expect(directories).toEqual(["/project"]);
});

test("a model chosen at launch is not replaced by the CLI default", async () => {
  const directories: string[] = [];
  const models = {
    list: async () => [],
    efforts: async () => [],
    startArgs: async () => ["--model", "example/beam"],
  };
  const { app: withModels } = createTestApp({
    store: createFakeStore(twoChatPanesState),
    panes: { split: async () => ({ paneId: "w1:p2" }) },
    models,
    loadPiDefaults: async (directory) => {
      directories.push(directory);
      return { model: "beam", effort: "high" };
    },
  });

  expect(
    (
      await post(withModels, "/api/panes/w1:p1/split", {
        agent: "pi",
        model: { provider: "example", id: "beam" },
      })
    ).status,
  ).toBe(200);

  const response = await withModels.request("/api/panes/w1:p2/default-model");
  expect(await response.json()).toEqual({ model: null, effort: null });
  expect(directories).toEqual([]);
});

test("panes that did not launch a pi default answer with no default", async () => {
  let calls = 0;
  const { app } = createTestApp({
    state,
    loadPiDefaults: async () => {
      calls += 1;
      return { model: "beam", effort: "high" };
    },
  });

  const response = await app.request("/api/panes/w1:p1/default-model");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ model: null, effort: null });
  expect(calls).toBe(0);
});

test("a pi pane started in an existing shell resolves its default too", async () => {
  const store = createFakeStore(state);
  const { app } = createTestApp({
    store,
    panes: {
      startAgent: async () => {
        store.push(chatState, true);
      },
    },
    loadPiDefaults: async () => ({ model: "beam", effort: "high" }),
  });

  const started = await post(app, "/api/panes/w1:p1/agent", { agent: "pi", model: null });
  expect(started.status).toBe(200);

  expect(await (await app.request("/api/panes/w1:p1/default-model")).json()).toEqual({
    model: "beam",
    effort: "high",
  });
});

test("recording a model drops the resolved default so the next empty conversation resolves it again", async () => {
  let calls = 0;
  let model: string | null = "beam-recorded";
  const app = defaultModelApp({
    chat: {
      snapshot: async () => ({ ...emptyChat, model }),
    },
    load: async () => {
      calls += 1;
      return { model: "beam", effort: "high" };
    },
  });

  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);
  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: "beam",
    effort: "high",
  });

  // 会話にモデルが載ると、解決済みの既定は捨てる。
  expect((await app.request("/api/panes/w1:p2/chat")).status).toBe(200);
  // /new でセッションが空に戻ったら、その時点の既定を取り直す。
  model = null;
  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: "beam",
    effort: "high",
  });
  expect(calls).toBe(2);
});

test("a failed default lookup does not invent a model and does not fail the launch", async () => {
  const app = defaultModelApp({
    load: async () => {
      throw new Error("Pi default model lookup failed");
    },
  });

  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);
  const response = await app.request("/api/panes/w1:p2/default-model");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "default_model_unavailable" });
});

test("the default model endpoint rejects a missing pane and a missing state", async () => {
  const app = defaultModelApp();
  expect((await app.request("/api/panes/w1:p9/default-model")).status).toBe(404);

  const { app: unavailable } = createTestApp({
    store: createFakeStore(null, new Error("socket closed")),
  });
  const response = await unavailable.request("/api/panes/w1:p1/default-model");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("closing the pane drops the remembered default", async () => {
  const app = defaultModelApp();
  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);
  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: "beam",
    effort: "high",
  });

  expect((await post(app, "/api/panes/w1:p2/close", {})).status).toBe(200);
  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: null,
    effort: null,
  });
});

test("a delayed default from a previous launch cannot replace the new launch", async () => {
  const settles: {
    resolve: (value: { model: string; effort: string | null }) => void;
    reject: (error: Error) => void;
  }[] = [];
  let loads = 0;
  const store = createFakeStore(twoChatPanesState);
  const shellState: AppState = {
    ...twoChatPanesState,
    workspaces: twoChatPanesState.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) =>
          pane.id === "w1:p2"
            ? { ...pane, agent: null, agentStatus: "idle" as const, chat: false }
            : pane,
        ),
      })),
    })),
  };
  const { app } = createTestApp({
    store,
    panes: {
      split: async () => ({ paneId: "w1:p2" }),
      startAgent: async () => {
        store.push(twoChatPanesState, true);
      },
    },
    loadPiDefaults: () => {
      loads += 1;
      return new Promise((resolve, reject) => settles.push({ resolve, reject }));
    },
  });

  // 1 回目の既定起動と、その既定値の解決を始める。
  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);
  const previous = app.request("/api/panes/w1:p2/default-model");
  await waitFor(() => loads === 1);

  // 終了して同じペインで既定起動し直す。
  expect((await post(app, "/api/panes/w1:p2/close", {})).status).toBe(200);
  store.push(shellState, true);
  expect((await post(app, "/api/panes/w1:p2/agent", { agent: "pi", model: null })).status).toBe(
    200,
  );
  const current = app.request("/api/panes/w1:p2/default-model");
  await waitFor(() => loads === 2);

  // 新しい起動を先に解決し、その後に古い問い合わせを返す。
  settles[1]!.resolve({ model: "beam-current", effort: "low" });
  expect(await (await current).json()).toEqual({ model: "beam-current", effort: "low" });
  settles[0]!.resolve({ model: "beam-previous", effort: "high" });
  expect(await (await previous).json()).toEqual({ model: "beam-previous", effort: "high" });

  // 古い問い合わせは、新しい起動のキャッシュを上書きしない。
  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: "beam-current",
    effort: "low",
  });
  expect(loads).toBe(2);
});
