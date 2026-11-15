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

test("recording a model in the session stops the default from being supplied", async () => {
  let calls = 0;
  const app = defaultModelApp({
    chat: {
      snapshot: async () => ({ ...emptyChat, model: "beam-recorded" }),
    },
    load: async () => {
      calls += 1;
      return { model: "beam", effort: "high" };
    },
  });

  expect((await post(app, "/api/panes/w1:p1/split", { agent: "pi" })).status).toBe(200);
  expect((await app.request("/api/panes/w1:p2/chat")).status).toBe(200);

  expect(await (await app.request("/api/panes/w1:p2/default-model")).json()).toEqual({
    model: null,
    effort: null,
  });
  expect(calls).toBe(0);
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
