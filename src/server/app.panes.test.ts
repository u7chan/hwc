import { expect, test } from "bun:test";
import { createApp } from "./app";
import type { PaneClient } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";
import {
  state,
  workingState,
  chatState,
  twoChatPanesState,
  createFakeStore,
  createTestApp,
} from "./app.test-helpers";

test("GET /api/panes/:id/output returns the pane output", async () => {
  const output = { paneId: "w1:p1", text: "hello\n", truncated: true, revision: 3 };
  const { app } = createTestApp({ panes: { read: async () => output } });
  const response = await app.request("/api/panes/w1:p1/output?lines=20");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...output, interaction: null });
});

test("GET /api/panes/:id/output forwards the parsed query to the pane client", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      read: async (options) => {
        seen.push(options);
        return { paneId: options.paneId, text: "", truncated: false, revision: 0 };
      },
    },
  });

  await app.request("/api/panes/w1:p1/output?source=visible&lines=5");

  expect(seen).toEqual([{ paneId: "w1:p1", source: "visible", lines: 5 }]);
});

// ペインを 1 枚触るルートは、状態を読んでから Herdr を呼び、失敗を同じ規則で HTTP に写す。
// 規則は BFF 側に 1 つしかないので、テストもルート横断で 1 つにする。
const paneActionCases = [
  { action: "output", method: "GET", call: "read", state, body: {}, guardsPane: true },
  // 添付の無い input は状態を読まずに Herdr へ送る。ペインの有無は Herdr が決める。
  { action: "input", method: "POST", call: "send", state, body: { text: "hi" }, guardsPane: false },
  { action: "stop", method: "POST", call: "stop", state: workingState, body: {}, guardsPane: true },
  {
    action: "clear-output",
    method: "POST",
    call: "clear",
    state,
    body: {},
    guardsPane: true,
  },
  { action: "focus", method: "POST", call: "focus", state, body: {}, guardsPane: true },
  {
    action: "close",
    method: "POST",
    call: "close",
    state: twoChatPanesState,
    body: {},
    guardsPane: true,
  },
  { action: "split", method: "POST", call: "layout", state, body: {}, guardsPane: true },
] as const;

function requestPaneAction(
  app: ReturnType<typeof createApp>,
  testCase: { action: string; method: string; body: unknown },
  paneId = "w1:p1",
) {
  return app.request(`/api/panes/${paneId}/${testCase.action}`, {
    method: testCase.method,
    headers: { "content-type": "application/json" },
    body: testCase.method === "POST" ? JSON.stringify(testCase.body) : undefined,
  });
}

// 呼ばれたこと自体を記録しておく。状態で止まるべきルートが Herdr まで進んだら分かる。
function failingPanes(
  method: keyof PaneClient,
  error: Error,
  calls: string[] = [],
): Partial<PaneClient> {
  return {
    [method]: async () => {
      calls.push(method);
      throw error;
    },
  } as Partial<PaneClient>;
}

test.each(paneActionCases.filter((testCase) => testCase.guardsPane))(
  "$action answers 404 for a pane the snapshot does not have, without asking Herdr",
  async (testCase) => {
    const calls: string[] = [];
    const { app } = createTestApp({
      state: testCase.state,
      panes: failingPanes(testCase.call, new Error("Herdr must not be called"), calls),
    });

    const response = await requestPaneAction(app, testCase, "w1:p9");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "pane_not_found" });
    expect(calls).toEqual([]);
  },
);

test.each(paneActionCases.filter((testCase) => testCase.guardsPane))(
  "$action answers 502 when the snapshot cannot be read",
  async (testCase) => {
    const { app } = createTestApp({ state: null, storeFailure: new Error("socket closed") });

    const response = await requestPaneAction(app, testCase);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "herdr_unavailable" });
  },
);

const paneFailures = paneActionCases.flatMap((testCase) =>
  [
    {
      kind: "pane_not_found",
      error: new HerdrError("pane_not_found", "no pane"),
      status: 404,
      expected: { error: "pane_not_found" },
    },
    {
      kind: "invalid_params",
      error: new HerdrError("invalid_params", "bad params"),
      status: 400,
      expected: { error: "invalid_request" },
    },
    {
      kind: "socket_closed",
      error: new HerdrError("socket_closed", "socket closed"),
      status: 502,
      expected: { error: "herdr_unavailable" },
    },
    {
      kind: "an unexpected error",
      error: new Error("socket closed"),
      status: 502,
      expected: { error: "herdr_unavailable" },
    },
  ].map((failure) => ({ ...testCase, ...failure })),
);

test.each(paneFailures)("$action maps $kind to $status", async (testCase) => {
  const { app } = createTestApp({
    state: testCase.state,
    panes: failingPanes(testCase.call, testCase.error),
  });

  const response = await requestPaneAction(app, testCase);

  expect(response.status).toBe(testCase.status);
  expect(await response.json()).toEqual(testCase.expected);
});

const jsonPaneActions = [
  "input",
  "stop",
  "focus",
  "close",
  "exit",
  "split",
  "confirm-folder-trust",
] as const;

test.each(jsonPaneActions)(
  "POST /api/panes/:id/%s rejects non-JSON before reading the body or state",
  async (action) => {
    let stateReads = 0;
    const store = createFakeStore(workingState);
    const { app } = createTestApp({
      store: {
        ...store,
        get: () => {
          stateReads += 1;
          return store.get();
        },
      },
    });

    for (const contentType of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=example",
      "application/jsonx",
      "application/json-patch+json",
    ]) {
      const request = new Request(`http://localhost/api/panes/w1:p1/${action}`, {
        method: "POST",
        headers: contentType === undefined ? {} : { "content-type": contentType },
        body: new TextEncoder().encode("not json"),
      });
      const response = await app.request(request);

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "content-type must be application/json" });
      expect(request.bodyUsed).toBe(false);
    }
    expect(stateReads).toBe(0);
  },
);

test.each(jsonPaneActions.filter((action) => action !== "confirm-folder-trust"))(
  "POST /api/panes/:id/%s accepts JSON media types regardless of case or parameters",
  async (action) => {
    const { app } = createTestApp({ state: action === "close" ? twoChatPanesState : workingState });

    for (const contentType of ["application/json", "Application/JSON; Charset=utf-8"]) {
      const response = await app.request(`/api/panes/w1:p1/${action}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(response.status).toBe(200);
    }
  },
);

test.each(["stop", "focus", "close", "exit"])(
  "POST /api/panes/:id/%s does not parse a body it does not need",
  async (action) => {
    const { app } = createTestApp({ state: action === "close" ? twoChatPanesState : workingState });
    const request = new Request(`http://localhost/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const response = await app.request(request);

    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
  },
);

test.each(["stop", "clear-output", "focus", "split"])(
  "POST /api/panes/:id/%s leaves snapshot refresh to Herdr events",
  async (action) => {
    let refreshes = 0;
    const store = createFakeStore(workingState);
    const { app } = createTestApp({
      store: {
        ...store,
        refresh: async () => {
          refreshes += 1;
          throw new Error("socket closed");
        },
      },
    });
    const response = await app.request(`/api/panes/w1:p1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(refreshes).toBe(0);
  },
);

test("POST /api/panes/:id/input without attachments does not need a snapshot", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: null,
    storeFailure: new Error("socket closed"),
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", submit: true }),
  });

  expect(response.status).toBe(200);
  expect(seen).toEqual([{ paneId: "w1:p1", text: "hello", submit: true }]);
});

test("POST /api/panes/:id/input sends the text and submits it", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls -la", submit: true }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1", text: "ls -la", submit: true }]);
});

test("POST /api/panes/:id/input rejects a body that is not JSON", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be an object" });
});

test("POST /api/panes/:id/input sends without submit", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      send: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(200);
  expect(seen).toEqual([{ paneId: "w1:p1", text: "ls", submit: false }]);
});

test("POST /api/panes/:id/input rejects a text that is too long", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(16_385) }),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "text must be at most 16384 bytes" });
});

test("GET /api/panes/:id/output rejects an unknown source", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p1/output?source=scrollback");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "source must be one of visible, recent, recent_unwrapped, detection",
  });
});

test("POST /api/panes/:id/stop sends Escape to a working pane", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    state: workingState,
    panes: {
      stop: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test("POST /api/panes/:id/stop does not send Escape to a pane that is not working", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      stop: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([]);
});

test("GET /api/panes/:id/process returns the foreground command", async () => {
  const { app } = createTestApp({
    panes: {
      process: async ({ paneId }) => ({
        running: true,
        command: `bun --watch ${paneId}`,
        ports: [3000],
      }),
    },
  });
  const response = await app.request("/api/panes/w1:p1/process");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    process: { running: true, command: "bun --watch w1:p1", ports: [3000] },
  });
});

test("GET /api/panes/:id/process rejects a pane that is not in the snapshot", async () => {
  const { app } = createTestApp();
  const response = await app.request("/api/panes/w1:p9/process");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("GET /api/panes/:id/process maps a Herdr failure to 502", async () => {
  const { app } = createTestApp({
    panes: {
      process: async () => {
        throw new HerdrError("pane_not_found", "no pane");
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/process");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("POST /api/panes/:id/stop sends Ctrl+C to a shell that is running something", async () => {
  const interrupted: unknown[] = [];
  const escaped: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      process: async () => ({ running: true, command: "bun --watch src/server.ts", ports: [3000] }),
      interrupt: async (options) => {
        interrupted.push(options);
      },
      stop: async (options) => {
        escaped.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(interrupted).toEqual([{ paneId: "w1:p1" }]);
  expect(escaped).toEqual([]);
});

test("POST /api/panes/:id/stop leaves a shell at a prompt alone", async () => {
  const interrupted: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      process: async () => ({ running: false, command: null, ports: [] }),
      interrupt: async (options) => {
        interrupted.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(interrupted).toEqual([]);
});

test("POST /api/panes/:id/clear-output asks Herdr to clear the pane buffer", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      clear: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/clear-output", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test("POST /api/panes/:id/focus focuses the pane by id", async () => {
  const seen: unknown[] = [];
  const { app } = createTestApp({
    panes: {
      focus: async (options) => {
        seen.push(options);
      },
    },
  });
  const response = await app.request("/api/panes/w1:p1/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([{ paneId: "w1:p1" }]);
});

test("the project list is read from the pane cwd", async () => {
  const directories: string[] = [];
  const cwds: string[] = [];
  const { app } = createTestApp({
    state: chatState,
    panes: {
      directory: async ({ paneId }) => {
        directories.push(paneId);
        return "/project/packages/app";
      },
    },
    projects: {
      list: async ({ cwd }) => {
        cwds.push(cwd);
        return { projects: [{ name: "api", path: "api" }], truncated: false };
      },
    },
  });

  const response = await app.request("/api/panes/w1:p1/projects");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    projects: [{ name: "api", path: "api" }],
    truncated: false,
  });
  expect(directories).toEqual(["w1:p1"]);
  expect(cwds).toEqual(["/project/packages/app"]);
});

test("a shell pane has no project list", async () => {
  const { app } = createTestApp({ state });
  const response = await app.request("/api/panes/w1:p1/projects");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("a failed project scan is reported separately from an empty list", async () => {
  const { app } = createTestApp({
    state: chatState,
    projects: {
      list: async () => {
        throw new Error("git failed");
      },
    },
  });

  const response = await app.request("/api/panes/w1:p1/projects");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "projects_unavailable" });
});

test("a pane that disappeared while reading its cwd keeps the pane error", async () => {
  const { app } = createTestApp({
    state: chatState,
    panes: {
      directory: async () => {
        throw new HerdrError("pane_not_found", "pane w1:p1 not found");
      },
    },
  });

  const response = await app.request("/api/panes/w1:p1/projects");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});
