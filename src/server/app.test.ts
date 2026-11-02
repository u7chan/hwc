import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { ChatClient } from "./chat/pi";
import { createChatClient } from "./chat/pi";
import type { ChatSnapshot } from "./chat/contract";
import type { PaneClient } from "./herdr/panes";
import { HerdrError } from "./herdr/socket";
import type { AppState, PaneState, StateStore } from "./herdr/state";

const pane: PaneState = {
  id: "w1:p1",
  title: null,
  agent: null,
  agentStatus: "idle",
  focused: true,
  chat: false,
};

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
      worktree: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "idle",
          focused: true,
          panes: [pane],
        },
      ],
    },
  ],
};

const chatPane: PaneState = { ...pane, agent: "pi", chat: true };

const chatState: AppState = {
  ...state,
  workspaces: [
    {
      ...state.workspaces[0]!,
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, panes: [chatPane] }],
    },
  ],
};

const sessionPath = "/sessions/--home-dev--/2026-01-01.jsonl";

type FakeStore = StateStore & {
  push: (state: AppState) => void;
  listenerCount: () => number;
  fireOnSubscribe: (state: AppState) => void;
  setSessionPath: (paneId: string, path: string | null) => void;
};

function createFakeStore(initial: AppState | null, failure?: Error): FakeStore {
  const listeners = new Set<(state: AppState) => void>();
  const sessions = new Map<string, string>();
  let current = initial;
  let pendingOnSubscribe: AppState | null = null;

  return {
    get: () => current,
    refresh: async () => {
      if (failure) throw failure;
      current ??= state;
      return current;
    },
    sessionPath: (paneId) => sessions.get(paneId) ?? null,
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
    setSessionPath: (paneId, path) => {
      if (path === null) sessions.delete(paneId);
      else sessions.set(paneId, path);
    },
    push: (next) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createFakeChat(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    snapshot: async () => emptyChat,
    ...overrides,
  };
}

const emptyChat: ChatSnapshot = {
  etag: "etag-1",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
};

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
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "dev" });
});

test("GET /api/health reports the revision it was built from", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
    revision: "abc1234",
  });
  const response = await app.request("/api/health");

  expect(await response.json()).toEqual({ ok: true, service: "hwc", revision: "abc1234" });
});

test("GET /api/state returns the current state", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state loads the state when the store is still empty", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(null),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(state);
});

test("GET /api/state returns 502 when Herdr cannot be read", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(null, new Error("socket closed")),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/state");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/events streams the current state first, then every update", async () => {
  const store = createFakeStore(state);
  const app = createApp({ chat: createFakeChat(), store, panes: createFakePanes() });
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
  const app = createApp({ chat: createFakeChat(), store, panes: createFakePanes() });
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
  const app = createApp({ chat: createFakeChat(), store, panes: createFakePanes() });
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
  const app = createApp({ chat: createFakeChat(), store, panes: createFakePanes() });
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
  const app = createApp({ chat: createFakeChat(), store, panes: createFakePanes() });
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
    chat: createFakeChat(),
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
    chat: createFakeChat(),
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
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/panes/w1:p1/output?lines=0");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "lines must be an integer between 1 and 4294967295",
  });
});

test("GET /api/panes/:id/output returns 404 when the pane is gone", async () => {
  const app = createApp({
    chat: createFakeChat(),
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
    chat: createFakeChat(),
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
    chat: createFakeChat(),
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
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "text must be a non-empty string" });
});

test("POST /api/panes/:id/input rejects a body that is not JSON", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
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
    chat: createFakeChat(),
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
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async (options) => {
        seen.push(options);
      },
    }),
  });

  for (const contentType of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/jsonx",
  ]) {
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

test("POST /api/panes/:id/input accepts a JSON content type with parameters", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("POST /api/panes/:id/input returns 400 when Herdr rejects the request", async () => {
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes({
      send: async () => {
        throw new HerdrError("invalid_params", "text is required");
      },
    }),
  });
  const response = await app.request("/api/panes/w1:p1/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "ls" }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("POST /api/panes/:id/input sends without submit", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    chat: createFakeChat(),
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
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
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
    chat: createFakeChat(),
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
    chat: createFakeChat(),
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
  const app = createApp({
    chat: createFakeChat(),
    store: createFakeStore(state),
    panes: createFakePanes(),
  });
  const response = await app.request("/api/panes/w1:p1/output?source=scrollback");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "source must be one of visible, recent, recent_unwrapped, detection",
  });
});

function createChatApp(options: { store?: FakeStore; chat?: ChatClient } = {}) {
  const store = options.store ?? createFakeStore(chatState);
  store.setSessionPath("w1:p1", sessionPath);
  return createApp({
    store,
    panes: createFakePanes(),
    chat: options.chat ?? createFakeChat(),
  });
}

test("GET /api/panes/:id/chat returns the conversation of the pane session", async () => {
  const messages = [{ id: "a1", role: "user" as const, text: "hello", at: 1_700_000_000_000 }];
  const seen: string[] = [];
  const chat = createFakeChat({
    snapshot: async (path) => {
      seen.push(path);
      return { ...emptyChat, messages };
    },
  });
  const app = createChatApp({ chat });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...emptyChat, messages });
  expect(response.headers.get("etag")).toBe(`"${emptyChat.etag}"`);
  expect(seen).toEqual([sessionPath]);
});

test("GET /api/panes/:id/chat answers 304 for a matching weak or listed If-None-Match", async () => {
  const app = createChatApp();

  const weak = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": 'W/"etag-1"' },
  });
  expect(weak.status).toBe(304);
  expect(weak.headers.get("etag")).toBe('"etag-1"');
  expect(await weak.text()).toBe("");

  const listed = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": '"other", "etag-1"' },
  });
  expect(listed.status).toBe(304);

  const any = await app.request("/api/panes/w1:p1/chat", { headers: { "if-none-match": "*" } });
  expect(any.status).toBe(304);
});

test("GET /api/panes/:id/chat returns the snapshot when the If-None-Match is stale", async () => {
  const app = createChatApp();

  const response = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": '"older"' },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(emptyChat);
});

test("GET /api/panes/:id/chat returns 404 pane_not_found for a pane that is gone", async () => {
  const app = createChatApp();

  const response = await app.request("/api/panes/w1:p9/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pane_not_found" });
});

test("GET /api/panes/:id/chat returns 404 no_chat for a pane without a session", async () => {
  const store = createFakeStore(state);
  const app = createChatApp({ store });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("GET /api/panes/:id/chat returns 404 no_chat when the state has no session path", async () => {
  const store = createFakeStore(chatState);
  const app = createApp({ store, panes: createFakePanes(), chat: createFakeChat() });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("GET /api/panes/:id/chat returns 502 when the state cannot be read", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.setSessionPath("w1:p1", sessionPath);
  const app = createApp({ store, panes: createFakePanes(), chat: createFakeChat() });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "herdr_unavailable" });
});

test("GET /api/panes/:id/chat returns 502 when the session cannot be read", async () => {
  const chat = createFakeChat({
    snapshot: async () => {
      throw new Error("session version 2 is not supported");
    },
  });
  const app = createChatApp({ chat });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "chat_unavailable" });
});

test("GET /api/panes/:id/chat returns an empty conversation for a session that is not written yet", async () => {
  const app = createChatApp({ chat: createChatClient() });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ messages: [], truncated: false });
});

test("GET /api/panes/:id/chat reads a session once for concurrent requests", async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = createChatClient({
    load: async () => {
      reads += 1;
      await gate;
      return emptyChat;
    },
  });
  const app = createChatApp({ chat });

  const first = app.request("/api/panes/w1:p1/chat");
  const second = app.request("/api/panes/w1:p1/chat");
  await Bun.sleep(20);
  expect(reads).toBe(1);
  release();

  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
});

test("GET /api/panes/:id/chat returns 200 after the pane session switched", async () => {
  const store = createFakeStore(chatState);
  const seen: string[] = [];
  const chat = createFakeChat({
    snapshot: async (path) => {
      seen.push(path);
      return { ...emptyChat, etag: `etag-${seen.length}` };
    },
  });
  const app = createApp({ store, panes: createFakePanes(), chat });
  store.setSessionPath("w1:p1", sessionPath);

  const first = await app.request("/api/panes/w1:p1/chat");
  store.setSessionPath("w1:p1", "/sessions/--home-dev--/2026-02-02.jsonl");
  const second = await app.request("/api/panes/w1:p1/chat", {
    headers: { "if-none-match": first.headers.get("etag") ?? "" },
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(seen).toEqual([sessionPath, "/sessions/--home-dev--/2026-02-02.jsonl"]);
});

test("GET /api/panes/:id/chat answers 304 while the session file stays gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-chat-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello", timestamp: 1_700_000_000_000 },
    },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  try {
    const store = createFakeStore(chatState);
    store.setSessionPath("w1:p1", file);
    const app = createApp({ store, panes: createFakePanes(), chat: createChatClient() });

    const first = await app.request("/api/panes/w1:p1/chat");
    expect(first.status).toBe(200);

    await rm(file);
    const gone = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ messages: [], truncated: false });

    const repeated = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": gone.headers.get("etag") ?? "" },
    });
    expect(repeated.status).toBe(304);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
