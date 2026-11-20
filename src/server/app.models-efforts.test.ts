import { expect, test } from "bun:test";
import { OpencodeServiceNotRunningError } from "./chat/opencode";
import { createTestApp } from "./app.test-helpers";

test.each(["pi", "claude", "codex", "opencode"] as const)(
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

test.each(["pi", "claude", "codex", "opencode"] as const)(
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

test.each(["agent=pi", "agent=pi&provider=example&model=--help"])(
  "GET /api/panes/:id/efforts rejects an invalid or missing model: %s",
  async (query) => {
    const { app } = createTestApp();
    expect((await app.request(`/api/panes/w1:p1/efforts?${query}`)).status).toBe(400);
  },
);

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

test.each(["unknown", ""])(
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

// 設定画面の候補はペインを持たない。BFF はホームディレクトリで読む。
test.each(["pi", "claude", "codex", "opencode"] as const)(
  "GET /api/models lists %s candidates in the home directory without a pane",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      homeDirectory: "/home/example",
      state: null,
      storeFailure: new Error("Herdr is not needed to read candidates"),
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
    const response = await app.request(`/api/models?agent=${agent}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [{ provider: "example", id: "beam" }] });
    expect(seen).toEqual([[agent, "/home/example"]]);
  },
);

test.each(["pi", "claude", "codex", "opencode"] as const)(
  "GET /api/efforts reads %s choices in the home directory without a pane",
  async (agent) => {
    const seen: unknown[] = [];
    const { app } = createTestApp({
      homeDirectory: "/home/example",
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
    const response = await app.request(`/api/efforts?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ efforts: ["eco", "max"] });
    expect(seen).toEqual([[agent, { provider: "example", id: "@demo/beam" }, "/home/example"]]);
  },
);

test.each(["/api/models?agent=unknown", "/api/efforts?agent=pi&provider=example&model=--help"])(
  "the home candidate routes reject an invalid query: %s",
  async (path) => {
    const { app } = createTestApp();
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  },
);

test("the home candidate routes fail in the same shape as the pane routes", async () => {
  const failing = createTestApp({
    models: {
      list: async (agent) => {
        if (agent === "opencode") throw new OpencodeServiceNotRunningError();
        throw new Error("/private/path: credential failure");
      },
      efforts: async () => {
        throw new Error("/private/path: credential failure");
      },
      startArgs: async () => [],
    },
  }).app;
  const cases = [
    ["/api/models?agent=opencode", { error: "opencode_not_running" }],
    ["/api/models?agent=pi", { error: "models_unavailable" }],
    ["/api/efforts?agent=pi&provider=example&model=beam", { error: "efforts_unavailable" }],
  ] as const;
  for (const [path, body] of cases) {
    const response = await failing.request(path);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(body);
  }

  // モデルの読み取り口が無い構成でも、同じ形で失敗する。
  const missing = createTestApp().app;
  expect(await (await missing.request("/api/models?agent=pi")).json()).toEqual({
    error: "models_unavailable",
  });
  expect(
    await (await missing.request("/api/efforts?agent=pi&provider=example&model=beam")).json(),
  ).toEqual({ error: "efforts_unavailable" });
});

// ラベルは候補とは別の口。ペインも Herdr も要らず、読めなければ null で返す。
test("GET /api/model-labels returns Claude labels without a pane", async () => {
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("Herdr is not needed to read labels"),
    modelLabels: {
      read: async () => ({ "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" }),
    },
  });
  const response = await app.request("/api/model-labels?agent=claude");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    labels: { "claude/opus": "Opus 5.5", "claude/sonnet": "Sonnet 5.5" },
  });
});

test("GET /api/model-labels hides a missing or failing label reader", async () => {
  const missing = createTestApp().app;
  expect(await (await missing.request("/api/model-labels?agent=claude")).json()).toEqual({
    labels: null,
  });

  const failing = createTestApp({
    modelLabels: {
      read: async () => {
        throw new Error("/private/path: credential failure");
      },
    },
  }).app;
  expect(await (await failing.request("/api/model-labels?agent=claude")).json()).toEqual({
    labels: null,
  });
});

test("GET /api/model-labels rejects agents that do not need a label lookup", async () => {
  const { app } = createTestApp();
  for (const agent of ["pi", "codex", "opencode", "unknown", ""]) {
    const response = await app.request(`/api/model-labels?agent=${agent}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
});
