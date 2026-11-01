import { expect, test } from "bun:test";
import { createApp } from "./app";
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
  const app = createApp({ store: createFakeStore(state) });
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "hwc" });
});

test("GET /api/state returns the current state", async () => {
  const app = createApp({ store: createFakeStore(state) });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state loads the state when the store is still empty", async () => {
  const app = createApp({ store: createFakeStore(null) });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state returns 502 when Herdr cannot be read", async () => {
  const app = createApp({ store: createFakeStore(null, new Error("socket closed")) });
  const response = await app.request("/api/state");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/events streams the current state first, then every update", async () => {
  const store = createFakeStore(state);
  const app = createApp({ store });
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
  const app = createApp({ store });
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
  const app = createApp({ store });
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
  const app = createApp({ store });
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
  const app = createApp({ store });
  const controller = new AbortController();
  const response = await app.request("/api/events", { signal: controller.signal });
  if (!response.body) throw new Error("response has no body");

  await response.body.cancel();
  controller.abort();

  await waitFor(() => store.listenerCount() === 0);
});
