import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatUnavailableError } from "./errors";
import {
  createOpencodeChatClient,
  defaultServicePath,
  readServiceFile,
  type OpencodeChatClient,
} from "./opencode";

const service = {
  url: new URL("http://127.0.0.1:4096"),
  authorization: "Basic b3BlbmNvZGU6c2VjcmV0",
};

const session = {
  data: {
    id: "ses_1",
    model: { id: "beam-free", providerID: "opencode-go", variant: "low" },
    location: { directory: "/repo" },
  },
};

const models = {
  data: [
    { id: "old-model", providerID: "opencode-go", limit: { context: 1000 } },
    { id: "beam-free", providerID: "opencode-go", limit: { context: 1_048_576 } },
  ],
};

function contextOf(...messages: unknown[]): { data: unknown[] } {
  return { data: messages };
}

function user(id: string, text: string, created = 1_000): unknown {
  return { id, type: "user", text, files: [], agents: [], time: { created } };
}

function assistant(
  id: string,
  content: unknown[],
  options: {
    created?: number;
    model?: unknown;
    tokens?: unknown;
  } = {},
): unknown {
  return {
    id,
    type: "assistant",
    time: { created: options.created ?? 2_000 },
    agent: "build",
    model: options.model ?? { id: "old-model", providerID: "opencode-go" },
    content,
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

function createClient(options: {
  messages?: unknown[];
  models?: unknown;
  request?: (path: string) => Promise<unknown>;
}): OpencodeChatClient {
  return createOpencodeChatClient({
    loadService: async () => service,
    request: async (_service, path) => {
      if (options.request) return options.request(path);
      if (path === "/api/session/ses_1") return session;
      if (path === "/api/session/ses_1/context") {
        return contextOf(...(options.messages ?? []));
      }
      if (path.startsWith("/api/model")) return options.models ?? models;
      throw new Error(`unexpected path: ${path}`);
    },
  });
}

test("opencode messages become the same chat snapshot as pi", async () => {
  const client = createClient({
    messages: [
      user("u1", "hello"),
      assistant(
        "a1",
        [
          { type: "reasoning", text: "thinking" },
          text("hi"),
          { type: "tool", id: "call_1", name: "read", state: {}, time: {} },
        ],
        {
          tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 0 } },
        },
      ),
    ],
  });

  const snapshot = await client.snapshot("ses_1");

  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_000 },
    { id: "a1", role: "agent", text: "hi", at: 2_000 },
  ]);
  // 表示はセッションの選択モデル。usage を出した assistant のモデルとは限らない。
  expect(snapshot.model).toBe("beam-free");
  expect(snapshot.effort).toBe("low");
  expect(snapshot.context).toEqual({ tokens: 20, window: 1_048_576 });
  expect(snapshot.truncated).toBe(false);
  expect(snapshot.compaction).toBeNull();
});

test("a tool-only assistant does not replace the context reading", async () => {
  const snapshot = await createClient({
    messages: [
      assistant("a1", [text("answer")], {
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      assistant("a2", [{ type: "tool", id: "call_1", name: "read", state: {}, time: {} }], {
        tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ],
  }).snapshot("ses_1");

  expect(snapshot.context).toEqual({ tokens: 12, window: 1_048_576 });
});

test("multiple text parts in one assistant message are separated", async () => {
  const snapshot = await createClient({
    messages: [assistant("a1", [text("first"), text("second")])],
  }).snapshot("ses_1");

  expect(snapshot.messages).toEqual([
    { id: "a1", role: "agent", text: "first\n\nsecond", at: 2_000 },
  ]);
});

test("the assistant model is used when the session has no model", async () => {
  const snapshot = await createOpencodeChatClient({
    loadService: async () => service,
    request: async (_service, path) => {
      if (path === "/api/session/ses_1") return { data: { location: { directory: "/repo" } } };
      if (path === "/api/session/ses_1/context") {
        return contextOf(
          assistant("a1", [text("hi")], {
            model: { id: "beam-free", providerID: "opencode-go", variant: "max" },
          }),
        );
      }
      if (path.startsWith("/api/model")) return models;
      throw new Error(`unexpected path: ${path}`);
    },
  }).snapshot("ses_1");

  expect(snapshot.model).toBe("beam-free");
  expect(snapshot.effort).toBe("max");
  expect(snapshot.context).toEqual({ tokens: null, window: 1_048_576 });
});

test("a completed compaction starts a new window", async () => {
  const snapshot = await createClient({
    messages: [
      user("u1", "old"),
      assistant("a1", [text("old answer")], {
        tokens: { input: 900, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      {
        id: "c1",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary of the old conversation",
        time: { created: 3_000 },
      },
      user("u2", "new", 4_000),
      assistant("a2", [text("new answer")], {
        created: 5_000,
        tokens: { input: 30, output: 1, reasoning: 2, cache: { read: 7, write: 0 } },
      }),
    ],
  }).snapshot("ses_1");

  expect(snapshot.messages).toEqual([
    { id: "u2", role: "user", text: "new", at: 4_000 },
    { id: "a2", role: "agent", text: "new answer", at: 5_000 },
  ]);
  expect(snapshot.compaction).toEqual({
    at: 3_000,
    tokensBefore: null,
    summary: "summary of the old conversation",
  });
  expect(snapshot.context).toEqual({ tokens: 40, window: 1_048_576 });
});

test("a failed compaction does not hide the conversation", async () => {
  const snapshot = await createClient({
    messages: [
      user("u1", "hello"),
      {
        id: "c1",
        type: "compaction",
        status: "failed",
        reason: "auto",
        error: { message: "failed" },
        time: { created: 2_000 },
      },
      assistant("a1", [text("hi")]),
    ],
  }).snapshot("ses_1");

  expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  expect(snapshot.compaction).toBeNull();
});

test("the hwc attachment note stays out of the text", async () => {
  const snapshot = await createClient({
    messages: [
      user("u1", "見て\n\n<attached_files>\n- /root/pasted-20260101-010203.png\n</attached_files>"),
    ],
  }).snapshot("ses_1");

  expect(snapshot.messages).toEqual([
    {
      id: "u1",
      role: "user",
      text: "見て",
      at: 1_000,
      attachments: ["pasted-20260101-010203.png"],
    },
  ]);
});

test("an empty user message without attachments is not shown", async () => {
  const snapshot = await createClient({ messages: [user("u1", "")] }).snapshot("ses_1");

  expect(snapshot.messages).toEqual([]);
});

test("the context window is left unknown when the model list cannot be read", async () => {
  const messages = [
    assistant("a1", [text("hi")], {
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ];
  const snapshot = await createClient({
    request: async (path) => {
      if (path === "/api/session/ses_1") return session;
      if (path === "/api/session/ses_1/context") return contextOf(...messages);
      throw new Error("model list is down");
    },
  }).snapshot("ses_1");

  expect(snapshot.model).toBe("beam-free");
  expect(snapshot.context).toEqual({ tokens: 12, window: null });
});

test("the etag is stable until the conversation changes", async () => {
  let messages = [user("u1", "hello")];
  const client = createClient({
    request: async (path) => {
      if (path === "/api/session/ses_1") return session;
      if (path === "/api/session/ses_1/context") return contextOf(...messages);
      if (path.startsWith("/api/model")) return models;
      throw new Error(`unexpected path: ${path}`);
    },
  });

  const first = await client.snapshot("ses_1");
  const repeated = await client.snapshot("ses_1");
  messages = [user("u1", "hello"), assistant("a1", [text("hi")])];
  const changed = await client.snapshot("ses_1");

  expect(repeated.etag).toBe(first.etag);
  expect(changed.etag).not.toBe(first.etag);
});

test("a service error is reported as chat unavailable", async () => {
  const client = createOpencodeChatClient({
    loadService: async () => service,
    request: async () => {
      throw new ChatUnavailableError("opencode service did not answer");
    },
  });

  await expect(client.snapshot("ses_1")).rejects.toBeInstanceOf(ChatUnavailableError);
});

test("the session path uses XDG_STATE_HOME when it is absolute", () => {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/state";
  try {
    expect(defaultServicePath()).toBe("/state/opencode/service.json");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("a service file with a password is read with basic auth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-opencode-"));
  const file = join(dir, "service.json");
  await writeFile(
    file,
    JSON.stringify({ url: "http://127.0.0.1:4096", password: "secret", pid: 1 }),
  );

  try {
    const loaded = await readServiceFile(file);
    expect(loaded.url.href).toBe("http://127.0.0.1:4096/");
    expect(loaded.authorization).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a service file outside loopback is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hwc-opencode-"));
  const file = join(dir, "service.json");
  await writeFile(
    file,
    JSON.stringify({ url: "http://192.0.2.1:4096", password: "secret", pid: 1 }),
  );

  try {
    await expect(readServiceFile(file)).rejects.toBeInstanceOf(ChatUnavailableError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
