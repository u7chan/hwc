import { expect, test } from "bun:test";
import { createApp } from "./app";
import type { PaneClient } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";
import type { AppState, StateStore } from "./herdr/state";

const state: AppState = {
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "idle",
          focused: true,
          panes: [{ id: "w1:p1", title: null, agent: null, agentStatus: "idle", focused: true }],
        },
      ],
    },
  ],
};

type FakeStore = StateStore & {
  push: (state: AppState) => void;
  listenerCount: () => number;
  fireOnSubscribe: (state: AppState) => void;
};

function createFakeStore(initial: AppState | null, failure?: Error): FakeStore {
  const listeners = new Set<(state: AppState) => void>();
  let current = initial;
  let pendingOnSubscribe: AppState | null = null;

  return {
    get: () => current,
    refresh: async () => {
      if (failure) throw failure;
      current ??= state;
      return current;
    },
    onChange: (listener) => {
      listeners.add(listener);
      if (pendingOnSubscribe) {
        const pending = pendingOnSubscribe;
        pendingOnSubscribe = null;
        listener(pending);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
    fireOnSubscribe: (state) => {
      pendingOnSubscribe = state;
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createFakePanes(overrides: Partial<PaneClient> = {}): PaneClient {
  return {
    read: async ({ paneId }) => ({ paneId, text: "hello\n", truncated: false, revision: 3 }),
    send: async () => {},
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met in time");
}

function createSseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  type SseEvent = { event: string | null; data: string };

  return {
    async nextEvent(): Promise<SseEvent> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = raw.split("\n");
          const event =
            lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? null;
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (event || data) return { event, data };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async next(): Promise<AppState> {
      return JSON.parse((await this.nextEvent()).data) as AppState;
    },
    cancel: () => reader.cancel(),
  };
}

test("GET /api/health returns ok", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "hwc" });
});

test("GET /api/state returns the current state", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state loads the state when the store is still empty", async () => {
  const app = createApp({ store: createFakeStore(null), panes: createFakePanes() });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state returns 502 when Herdr cannot be read", async () => {
  const app = createApp({
    store: createFakeStore(null, new Error("socket closed")),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/events streams the current state first, then every update", async () => {
  const store = createFakeStore(state);
  const app = createApp({ store, panes: createFakePanes() });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.next()).toEqual(state);

  const next: AppState = { ...state, focusedPaneId: null };
  store.push(next);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events stays open and sends the state once Herdr becomes readable", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  const app = createApp({ store, panes: createFakePanes() });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toEqual({ event: "unavailable", data: "" });

  store.push(state);
  expect(await events.next()).toEqual(state);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events uses an update that arrived first instead of reporting unavailability", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.fireOnSubscribe(state);
  const app = createApp({ store, panes: createFakePanes() });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.nextEvent()).toMatchObject({ event: null });

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events flushes an update that arrives while the initial state is being sent", async () => {
  const store = createFakeStore(state);
  const next: AppState = { ...state, focusedPaneId: "w1:p9" };
  store.fireOnSubscribe(next);
  const app = createApp({ store, panes: createFakePanes() });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");
  const events = createSseReader(response.body);

  expect(await events.next()).toEqual(state);
  expect(await events.next()).toEqual(next);

  await events.cancel();
  controller.abort();
  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/events unsubscribes when the client is gone before the initial state is sent", async () => {
  const store = createFakeStore(state);
  const app = createApp({ store, panes: createFakePanes() });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  await response.body.cancel();
  controller.abort();

  await waitFor(() => store.listenerCount() === 0);
});

test("GET /api/panes/:id/output returns the pane output", async () => {
  const output = { paneId: "w1:p1", text: "hello\n", truncated: true, revision: 3 };
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({ read: async () => output }),
  });
  const response = await app.request("/api/panes/w1:p1/output?lines=20");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(output);
});

test("GET /api/panes/:id/output forwards the parsed query to the pane client", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      read: async (options) => {
        seen.push(options);
        return { paneId: options.paneId, text: "", truncated: false, revision: 0 };
      },
    }),
  });

  await app.request("/api/panes/w1:p1/output?source=visible&lines=5");

  expect(seen).toEqual([{ paneId: "w1:p1", source: "visible", lines: 5 }]);
});

test("GET /api/panes/:id/output rejects a lines value that is out of range", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/panes/w1:p1/output?lines=0");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "lines must be an integer between 1 and 4294967295",
  });
});

test("GET /api/panes/:id/output returns 404 when the pane is gone", async () => {
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      read: async () => {
        throw new HerdrError("pane_not_found", "pane w1:p9 not found");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p9/output");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("GET /api/panes/:id/output returns 502 when Herdr cannot be reached", async () => {
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      read: async () => {
        throw new Error("socket closed");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p1/output");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("POST /api/panes/:id/input sends the text and submits it", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async (options) => {
        seen.push(options);
      },
    }),
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

test("POST /api/panes/:id/input rejects a blank text", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "text must be a non-empty string" });
});

test("POST /api/panes/:id/input rejects a body that is not JSON", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "body must be an object" });
});

test("POST /api/panes/:id/input returns 502 when Herdr cannot be reached", async () => {
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async () => {
        throw new Error("socket closed");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("POST /api/panes/:id/input rejects a body that is not sent as JSON", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async (options) => {
        seen.push(options);
      },
    }),
  });

  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify({ text: "rm -rf /", submit: true }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "content-type must be application/json" });
  }

  expect(seen).toEqual([]);
});

test("POST /api/panes/:id/input sends without submit", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async (options) => {
        seen.push(options);
      },
    }),
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
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(16_385) }),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "text must be at most 16384 bytes" });
});

test("POST /api/panes/:id/input returns 404 when the pane is gone", async () => {
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async () => {
        throw new HerdrError("pane_not_found", "pane w1:p9 not found");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p9/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("GET /api/panes/:id/output returns 400 when Herdr rejects the request", async () => {
  const app = createApp({
    store: createFakeStore(state),
    panes: createFakePanes({
      read: async () => {
        throw new HerdrError("invalid_params", "pane_id is required");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p1/output");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("GET /api/panes/:id/output rejects an unknown source", async () => {
  const app = createApp({ store: createFakeStore(state), panes: createFakePanes() });
  const response = await app.request("/api/panes/w1:p1/output?source=scrollback");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "source must be one of visible, recent, recent_unwrapped, detection",
  });
});
