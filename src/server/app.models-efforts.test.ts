import { expect, test } from "bun:test";
import { OpencodeServiceNotRunningError } from "./chat/opencode";
import { createTestApp } from "./app.test-helpers";

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
