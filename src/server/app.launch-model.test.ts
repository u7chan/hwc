import { expect, test } from "bun:test";
import type { AppState } from "./herdr/state";
import { createFakeStore, createTestApp, state, twoChatPanesState } from "./app.test-helpers";

const claudePanesState: AppState = {
  ...twoChatPanesState,
  workspaces: twoChatPanesState.workspaces.map((workspace) => ({
    ...workspace,
    tabs: workspace.tabs.map((tab) => ({
      ...tab,
      panes: tab.panes.map((pane) => ({ ...pane, agent: "claude" as const })),
    })),
  })),
};

function post(app: ReturnType<typeof createTestApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function launchModelApp(options: { state?: AppState } = {}) {
  const { app } = createTestApp({
    state: options.state ?? claudePanesState,
    panes: { split: async () => ({ paneId: "w1:p2" }) },
    models: {
      list: async () => [],
      efforts: async () => ["low", "medium", "high"],
      startArgs: async (_agent, model, _directory, effort) => [
        "--model",
        model.id,
        ...(effort == null ? [] : ["--effort", effort]),
      ],
    },
  });
  return app;
}

test("a model chosen at launch is readable after the chat is not available", async () => {
  const app = launchModelApp();
  expect(
    (
      await post(app, "/api/panes/w1:p1/split", {
        agent: "claude",
        model: { provider: "claude", id: "sonnet" },
        effort: "medium",
      })
    ).status,
  ).toBe(200);

  const response = await app.request("/api/panes/w1:p2/launch-model");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ model: "sonnet", effort: "medium" });
});

test("a launch without a model keeps no launch model", async () => {
  const app = launchModelApp();
  expect((await post(app, "/api/panes/w1:p1/split", { agent: "claude" })).status).toBe(200);

  expect(await (await app.request("/api/panes/w1:p2/launch-model")).json()).toEqual({
    model: null,
    effort: null,
  });
});

test("a shell pane has no launch model", async () => {
  const app = launchModelApp({ state });
  expect(await (await app.request("/api/panes/w1:p1/launch-model")).json()).toEqual({
    model: null,
    effort: null,
  });
});

test("closing the pane drops the remembered launch model", async () => {
  const app = launchModelApp();
  expect(
    (
      await post(app, "/api/panes/w1:p1/split", {
        agent: "claude",
        model: { provider: "claude", id: "sonnet" },
        effort: "medium",
      })
    ).status,
  ).toBe(200);

  expect((await post(app, "/api/panes/w1:p2/close", {})).status).toBe(200);
  expect(await (await app.request("/api/panes/w1:p2/launch-model")).json()).toEqual({
    model: null,
    effort: null,
  });
});

test("the launch model endpoint rejects a missing pane and a missing state", async () => {
  const app = launchModelApp();
  expect((await app.request("/api/panes/w1:p9/launch-model")).status).toBe(404);

  const { app: unavailable } = createTestApp({
    store: createFakeStore(null, new Error("socket closed")),
  });
  const response = await unavailable.request("/api/panes/w1:p1/launch-model");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});
