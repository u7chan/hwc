import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ChatClient, createChatClient } from "./chat/pi";
import type { ChatSnapshot } from "./chat/contract";
import {
  type FakeStore,
  state,
  chatState,
  sessionPath,
  createFakeStore,
  createFakeChat,
  emptyChat,
  createTestApp,
  pngBytes,
  withCheckout,
  createFilesApp,
} from "./app.test-helpers";

function createChatApp(options: { store?: FakeStore; chat?: ChatClient } = {}) {
  const { app, store } = createTestApp({
    store: options.store,
    state: chatState,
    chat: options.chat,
  });
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  return app;
}

test("GET /api/panes/:id/chat returns the conversation of the pane session", async () => {
  const messages = [{ id: "a1", role: "user" as const, text: "hello", at: 1_700_000_000_000 }];
  const context = { tokens: 122_600, window: 1_000_000 };
  const seen: string[] = [];
  const chat = createFakeChat({
    snapshot: async (path) => {
      seen.push(path);
      return { ...emptyChat, messages, context };
    },
  });
  const app = createChatApp({ chat });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...emptyChat, messages, context });
  expect(response.headers.get("etag")).toBe(`"${emptyChat.etag}"`);
  expect(seen).toEqual([sessionPath]);
});

test.each(["codex", "opencode"] as const)(
  "GET /api/panes/:id/chat reads a %s session through its own client",
  async (agent) => {
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent, sessionId: "ses_abc" });
    const seen: string[] = [];
    const client = createFakeChat({
      snapshot: async (sessionId) => {
        seen.push(sessionId);
        return { ...emptyChat, etag: agent };
      },
    });
    const { app } = createTestApp({
      store,
      chat: createFakeChat({
        snapshot: async () => {
          throw new Error("the pi client must not read another agent's session");
        },
      }),
      [agent]: client,
    });

    const response = await app.request("/api/panes/w1:p1/chat");

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${agent}"`);
    expect(seen).toEqual(["ses_abc"]);
    const unchanged = await app.request("/api/panes/w1:p1/chat", {
      headers: { "if-none-match": `W/"${agent}"` },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  },
);

test.each(["codex", "opencode"] as const)(
  "GET /api/panes/:id/chat returns 502 when the %s client is not configured",
  async (agent) => {
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent, sessionId: "ses_abc" });
    const { app } = createTestApp({ store });

    const response = await app.request("/api/panes/w1:p1/chat");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "chat_unavailable" });
  },
);

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

test("GET /api/panes/:id/chat returns 404 no_chat when the store has no chat source", async () => {
  const store = createFakeStore(chatState);
  const { app } = createTestApp({ store });

  const response = await app.request("/api/panes/w1:p1/chat");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no_chat" });
});

test("GET /api/panes/:id/chat returns 502 when the state cannot be read", async () => {
  const store = createFakeStore(null, new Error("socket closed"));
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });
  const { app } = createTestApp({ store });

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
  const { app } = createTestApp({
    store,
    chat: chat,
  });
  store.setChatSource("w1:p1", { agent: "pi", path: sessionPath });

  const first = await app.request("/api/panes/w1:p1/chat");
  store.setChatSource("w1:p1", {
    agent: "pi",
    path: "/sessions/--home-dev--/2026-02-02.jsonl",
  });
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
    store.setChatSource("w1:p1", { agent: "pi", path: file });
    const { app } = createTestApp({
      store,
      chat: createChatClient(),
    });

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

test("GET /api/panes/:id/chat returns 200 for a catalog-only window change and 304 for other models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-chat-"));
  try {
    const sessions = join(dir, "sessions", "demo");
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, "session.jsonl");
    const lines = [
      { type: "session", version: 3, id: "session-1" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          provider: "p",
          model: "m",
          usage: { totalTokens: 1_000 },
        },
      },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const catalogFile = join(dir, "models-store.json");
    const catalog = (window: number, other = 100_000) => ({
      p: {
        models: [
          { id: "m", contextWindow: window },
          { id: "other", contextWindow: other },
        ],
      },
    });
    await writeFile(catalogFile, JSON.stringify(catalog(100_000)));
    const store = createFakeStore(chatState);
    store.setChatSource("w1:p1", { agent: "pi", path: file });
    const { app } = createTestApp({
      store,
      chat: createChatClient(),
    });
    const request = (etag: string | null) =>
      app.request("/api/panes/w1:p1/chat", { headers: { "if-none-match": etag ?? "" } });

    const first = await request(null);
    expect(first.status).toBe(200);
    const before = (await first.json()) as ChatSnapshot;
    expect(before.context).toEqual({ tokens: 1_000, window: 100_000 });
    expect((await request(first.headers.get("etag"))).status).toBe(304);

    await writeFile(catalogFile, JSON.stringify(catalog(1_000_000)));
    const changed = await request(first.headers.get("etag"));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(await changed.json()).toMatchObject({
      context: { tokens: 1_000, window: 1_000_000 },
      messages: before.messages,
      model: before.model,
    });
    expect((await request(changed.headers.get("etag"))).status).toBe(304);

    await writeFile(catalogFile, JSON.stringify(catalog(1_000_000, 200_000)));
    expect((await request(changed.headers.get("etag"))).status).toBe(304);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/panes/:id/chat labels the /tmp root of a pane without a checkout", async () => {
  const dir = await mkdtemp(join("/tmp", "hwc-default-root-"));
  const page = join(dir, "mock.html");
  await writeFile(page, "<!doctype html>");

  try {
    const app = createFilesApp(null, {
      previewRoots: ["/tmp"],
      chat: {
        snapshot: async () => ({
          ...emptyChat,
          messages: [{ id: "a1", role: "agent", text: `モックは \`${page}\` です。`, at: 1 }],
        }),
      },
    });

    const response = await app.request("/api/panes/w1:p1/chat");
    const body = (await response.json()) as {
      messages: { files?: { name: string; root: number; rootLabel?: string }[] }[];
    };
    // チェックアウトが無いペインでは /tmp が 0 番。ラベルは番号ではなく設定値から作る。
    expect(body.messages[0]?.files?.[0]).toMatchObject({
      name: `${basename(dir)}/mock.html`,
      root: 0,
      rootLabel: "/tmp",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/panes/:id/chat adds the images the agent pointed at", async () => {
  await withCheckout(async (root) => {
    await writeFile(join(root, "mock.png"), pngBytes);
    const app = createFilesApp(root, {
      chat: {
        snapshot: async () => ({
          ...emptyChat,
          messages: [
            { id: "a1", role: "agent", text: "モックは `mock.png` に置きました。", at: 1 },
          ],
        }),
      },
    });

    const response = await app.request("/api/panes/w1:p1/chat");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      etag: string;
      messages: { files?: { name: string; version: string; kind: string }[] }[];
    };
    expect(body.messages[0]?.files?.map((file) => file.name)).toEqual(["mock.png"]);
    expect(body.messages[0]?.files?.map((file) => file.kind)).toEqual(["image"]);
    expect(body.etag).not.toBe(emptyChat.etag);

    // 画像を作り直すと本文は同じでも etag が変わり、次の取得で新しい URL になる。
    await writeFile(join(root, "mock.png"), new Uint8Array([...pngBytes, 0]));
    const refreshed = await app.request("/api/panes/w1:p1/chat");
    expect(refreshed.headers.get("etag")).not.toBe(response.headers.get("etag"));
  });
});
