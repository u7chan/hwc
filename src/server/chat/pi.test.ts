import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChatReader, ChatUnavailableError, createChatClient } from "./pi";

let dir: string;
let fileCount = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hwc-chat-"));
  fileCount = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 1 行 1 エントリの追記型。書き込みは毎回新しいファイルにして、増分リーダーを試す。
async function writeSession(...lines: readonly string[]): Promise<string> {
  fileCount += 1;
  const path = join(dir, `session-${fileCount}.jsonl`);
  await writeFile(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

const header = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/home/dev/workspaces/hwc",
    ...overrides,
  });

const entry = (
  type: string,
  id: string,
  parentId: string | null,
  fields: Record<string, unknown> = {},
): string =>
  JSON.stringify({ type, id, parentId, timestamp: "2026-01-01T00:00:01.000Z", ...fields });

const user = (id: string, parentId: string | null, content: unknown): string =>
  entry("message", id, parentId, {
    message: { role: "user", content, timestamp: 1_700_000_000_000 },
  });

const assistant = (
  id: string,
  parentId: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
): string =>
  entry("message", id, parentId, {
    message: {
      role: "assistant",
      content,
      model: "claude-sonnet-4-5",
      timestamp: 1_700_000_000_001,
      ...extra,
    },
  });

const text = (value: string): unknown[] => [{ type: "text", text: value }];

const usage = (totalTokens: number, extra: Record<string, unknown> = {}): unknown => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  ...extra,
});

// window を引くには <agent-dir>/sessions/<slug>/<file>.jsonl の形が要る。
async function writeAgentSession(agentDir: string, ...lines: readonly string[]): Promise<string> {
  fileCount += 1;
  const path = join(agentDir, "sessions", "slug", `session-${fileCount}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

async function writeCatalog(
  agentDir: string,
  files: { store?: unknown; config?: unknown },
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  for (const [name, body] of [
    ["models-store.json", files.store],
    ["models.json", files.config],
  ] as const) {
    if (body !== undefined) await writeFile(join(agentDir, name), JSON.stringify(body));
  }
}

const providerModels = (models: Array<Record<string, unknown>>): unknown => ({ models });

test("returns only the user and assistant text in order", async () => {
  const path = await writeSession(
    header(),
    entry("message", "s1", null, {
      message: { role: "system", content: "", sections: { preamble: "..." } },
    }),
    user("u1", "s1", "hello"),
    assistant("a1", "u1", [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "hi there" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]),
    entry("message", "t1", "a1", {
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: text("output"),
        isError: false,
        timestamp: 1_700_000_000_002,
      },
    }),
    entry("custom", "c1", "t1", { customType: "note", data: { count: 1 } }),
    user("u2", "c1", "thanks"),
    assistant("a2", "u2", text("done")),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_700_000_000_000 },
    { id: "a1", role: "agent", text: "hi there", at: 1_700_000_000_001 },
    { id: "u2", role: "user", text: "thanks", at: 1_700_000_000_000 },
    { id: "a2", role: "agent", text: "done", at: 1_700_000_000_001 },
  ]);
  expect(snapshot.truncated).toBe(false);
});

test("drops an assistant entry whose text is empty", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "run it"),
    assistant("a1", "u1", [
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "run it", at: 1_700_000_000_000 },
  ]);
  // 本文は無くても、そのターンで使った model は最新として残る。
  expect(snapshot.model).toBe("claude-sonnet-4-5");
});

test("reads a user message from a string or from content blocks", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, [{ type: "image", data: "...", mimeType: "image/png" }]),
    user("u2", "u1", [
      { type: "text", text: "look at " },
      { type: "image", data: "...", mimeType: "image/png" },
      { type: "text", text: "this" },
    ]),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.text)).toEqual(["[画像]", "look at this"]);
});

test("keeps the images a user message was sent with, and drops the note from the text", async () => {
  const note =
    "<attached_files>\n- /state/attachments/w1:p1/pasted-20261103-120000.png\n</attached_files>";
  const path = await writeSession(
    header(),
    user("u1", null, `look at this\n\n${note}`),
    // 画像だけを送ると本文は空になる。それでも履歴から消さない。
    user("u2", "u1", note),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toEqual([
    {
      id: "u1",
      role: "user",
      text: "look at this",
      at: 1_700_000_000_000,
      attachments: ["pasted-20261103-120000.png"],
    },
    {
      id: "u2",
      role: "user",
      text: "",
      at: 1_700_000_000_000,
      attachments: ["pasted-20261103-120000.png"],
    },
  ]);
});

test("a user message without a note carries no attachments", async () => {
  const path = await writeSession(header(), user("u1", null, "hello"));

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_700_000_000_000 },
  ]);
});

test("drops a line that is not JSON without breaking the rest of the session", async () => {
  const path = await writeSession(
    header(),
    "{not json",
    user("u1", null, "hello"),
    entry("unknown_type", "x1", "u1", { payload: true }),
    assistant("a1", "x1", text("hi")),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.text)).toEqual(["hello", "hi"]);
});

test("reads only the appended lines on the next request", async () => {
  const path = await writeSession(header(), user("u1", null, "hello"));
  const chat = createChatClient();

  const before = await chat.snapshot(path);
  await writeFile(path, assistant("a1", "u1", text("hi")) + "\n", { flag: "a" });
  const after = await chat.snapshot(path);

  expect(before.messages.map((message) => message.text)).toEqual(["hello"]);
  expect(after.messages.map((message) => message.text)).toEqual(["hello", "hi"]);
  expect(after.etag).not.toBe(before.etag);
});

test("keeps the trailing incomplete line for the next request", async () => {
  const path = join(dir, "incomplete.jsonl");
  const line = user("u1", null, "hello");
  // pi は 1 行を書き切る前に落ちることがある。続きは次の書き込みで届く。
  await writeFile(path, `${header()}\n${line.slice(0, 40)}`);
  const chat = createChatClient();

  expect((await chat.snapshot(path)).messages).toEqual([]);

  await writeFile(path, `${line.slice(40)}\n${assistant("a1", "u1", text("hi"))}\n`, { flag: "a" });
  const after = await chat.snapshot(path);

  expect(after.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
});

test("returns only the messages on the active branch", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "start"),
    assistant("a1", "u1", text("first answer")),
    user("u2", "a1", "path A"),
    assistant("a2", "u2", text("answer A")),
    // /tree で u1 から分岐し直した状態。末尾が新しい枝になる。
    user("u3", "u1", "path B"),
    assistant("a3", "u3", text("answer B")),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.text)).toEqual(["start", "path B", "answer B"]);
});

test("resets when the session header id changed even though the file grew", async () => {
  const path = await writeSession(
    header({ id: "session-1" }),
    user("u1", null, "old"),
    assistant("a1", "u1", text("old answer")),
  );
  const chat = createChatClient();

  expect((await chat.snapshot(path)).messages).toHaveLength(2);

  // v1/v2 からの rewrite は同じ inode の truncate で長くなることがある。
  await writeFile(
    path,
    [
      header({ id: "session-2" }),
      user("v1", null, "new one"),
      assistant("v2", "v1", text("new answer")),
      user("v3", "v2", "another"),
      assistant("v4", "v3", text("another answer")),
      "",
    ].join("\n"),
  );
  const after = await chat.snapshot(path);

  expect(after.messages.map((message) => message.id)).toEqual(["v1", "v2", "v3", "v4"]);
});

test("resets when the file became shorter than what was already read", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "one"),
    assistant("a1", "u1", text("two")),
    user("u2", "a1", "three"),
  );
  const chat = createChatClient();

  expect((await chat.snapshot(path)).messages).toHaveLength(3);

  await writeFile(path, [header(), user("n1", null, "fresh"), ""].join("\n"));
  const after = await chat.snapshot(path);

  expect(after.messages.map((message) => message.text)).toEqual(["fresh"]);
});

test("rejects a session that is not version 3", async () => {
  const path = await writeSession(header({ version: 2 }), user("u1", null, "hello"));

  await expect(createChatClient().snapshot(path)).rejects.toBeInstanceOf(ChatUnavailableError);
});

test("resolves model and thinking level on the active branch", async () => {
  const path = await writeSession(
    header(),
    entry("model_change", "m1", null, { provider: "anthropic", modelId: "claude-sonnet-4-5" }),
    entry("thinking_level_change", "l1", "m1", { thinkingLevel: "low" }),
    user("u1", "l1", "hello"),
    assistant("a1", "u1", text("hi"), { thinkingLevel: "medium" }),
    user("u2", "a1", "next"),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot).toMatchObject({ model: "claude-sonnet-4-5", effort: "medium" });
});

test("takes a model change that follows the last assistant message", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), { thinkingLevel: "high" }),
    entry("model_change", "m1", "a1", { provider: "openai", modelId: "gpt-5" }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot).toMatchObject({ model: "gpt-5", effort: "high" });
});

test("keeps the newest 500 messages and reports the truncation", async () => {
  const lines = [header()];
  let parentId: string | null = null;
  for (let index = 0; index < 600; index += 1) {
    const id = `u${index}`;
    lines.push(user(id, parentId, `message ${index}`));
    parentId = id;
  }
  const path = await writeSession(...lines);

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toHaveLength(500);
  expect(snapshot.messages[0]?.text).toBe("message 100");
  expect(snapshot.messages.at(-1)?.text).toBe("message 599");
  expect(snapshot.truncated).toBe(true);
});

test("cuts the conversation at 1MB and keeps a single oversized message alone", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "a".repeat(600_000)),
    user("u2", "u1", "b".repeat(600_000)),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.id)).toEqual(["u2"]);
  expect(snapshot.truncated).toBe(true);

  const huge = await writeSession(
    header(),
    user("u1", null, "before"),
    user("u2", "u1", "a".repeat(1_200_000)),
  );
  const oversized = await createChatClient().snapshot(huge);

  // 1 件で上限を超える場合でも、その 1 件は返す。
  expect(oversized.messages.map((message) => message.id)).toEqual(["u2"]);
  expect(oversized.truncated).toBe(true);
});

test("treats a session that does not exist yet as an empty conversation", async () => {
  const path = join(dir, "missing", "session.jsonl");
  const chat = createChatClient();

  const first = await chat.snapshot(path);
  const second = await chat.snapshot(path);

  expect(first.messages).toEqual([]);
  expect(first).toMatchObject({ model: null, effort: null, truncated: false });
  // 一度もファイルを見ていない path は世代 0 のまま。
  expect(first.etag).toEndWith("-0");
  expect(second.etag).toBe(first.etag);
});

test("keeps the etag stable while the session file stays gone", async () => {
  const path = await writeSession(header(), user("u1", null, "hello"));
  const chat = createChatClient();

  const before = await chat.snapshot(path);
  await rm(path);

  const gone = await chat.snapshot(path);
  const stillGone = await chat.snapshot(path);

  expect(gone.messages).toEqual([]);
  // 消えたことは 1 度だけ世代に反映する。ENOENT が続く間は同じ内容を返す。
  expect(gone.etag).not.toBe(before.etag);
  expect(stillGone.etag).toBe(gone.etag);
});

test("keeps the etag stable until a complete line is appended", async () => {
  const path = await writeSession(header(), user("u1", null, "hello"));
  const chat = createChatClient();

  const first = await chat.snapshot(path);
  expect((await chat.snapshot(path)).etag).toBe(first.etag);

  // 未完行は会話を変えないので、etag も変えない。
  await writeFile(path, assistant("a1", "u1", text("hi")), { flag: "a" });
  expect((await chat.snapshot(path)).etag).toBe(first.etag);

  await writeFile(path, "\n", { flag: "a" });
  expect((await chat.snapshot(path)).etag).not.toBe(first.etag);
});

test("gives different sessions different etags", async () => {
  const one = await writeSession(header(), user("u1", null, "hello"));
  const two = await writeSession(header(), user("u1", null, "hello"));
  const chat = createChatClient();

  const [first, second] = await Promise.all([chat.snapshot(one), chat.snapshot(two)]);

  expect(first.messages).toEqual(second.messages);
  expect(first.etag).not.toBe(second.etag);
});

test("reuses one reader per session and evicts the least recently used one", async () => {
  const seen: Array<{ path: string; reader: ChatReader }> = [];
  const chat = createChatClient({
    limit: 2,
    load: async (reader) => {
      seen.push({ path: reader.path, reader });
      return {
        etag: reader.etagPrefix,
        messages: [],
        model: null,
        effort: null,
        truncated: false,
        context: null,
        compaction: null,
      };
    },
  });

  await chat.snapshot("/sessions/a.jsonl");
  await chat.snapshot("/sessions/a.jsonl");
  await chat.snapshot("/sessions/b.jsonl");
  await chat.snapshot("/sessions/c.jsonl");
  await chat.snapshot("/sessions/a.jsonl");

  expect(seen.map((item) => item.path)).toEqual([
    "/sessions/a.jsonl",
    "/sessions/a.jsonl",
    "/sessions/b.jsonl",
    "/sessions/c.jsonl",
    "/sessions/a.jsonl",
  ]);
  expect(seen[1]?.reader).toBe(seen[0]?.reader);
  // 上限 2 を超えたので a は捨てられ、次の要求で作り直される。
  expect(seen[4]?.reader).not.toBe(seen[0]?.reader);
});

const agentDir = (): string => join(dir, "agent");

test("reads tokens and the window from the session's agent dir catalog", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: {
      "opencode-go": providerModels([{ id: "deepseek-v4.1-flash", contextWindow: 1_000_000 }]),
    },
  });
  const path = await writeAgentSession(
    agent,
    header(),
    entry("model_change", "m1", null, {
      provider: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    }),
    user("u1", "m1", "hello"),
    assistant("a1", "u1", text("hi"), {
      model: "deepseek-v4.1-flash",
      provider: "opencode-go",
      stopReason: "endTurn",
      usage: usage(122_600),
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.context).toEqual({ tokens: 122_600, window: 1_000_000 });
});

test("a model override in models.json wins over the stored window", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: { "openai-codex": providerModels([{ id: "gpt-6-luna", contextWindow: 272_000 }]) },
    config: {
      providers: {
        "openai-codex": { modelOverrides: { "gpt-6-luna": { contextWindow: 1_050_000 } } },
      },
    },
  });
  const path = await writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), {
      model: "gpt-6-luna",
      provider: "openai-codex",
      usage: usage(1_000),
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.context).toEqual({ tokens: 1_000, window: 1_050_000 });
});

test("an override for a model the store does not have stays unknown", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: { p: providerModels([]) },
    config: { providers: { p: { modelOverrides: { m: { contextWindow: 1_000_000 } } } } },
  });
  const path = await writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(1_000) }),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 1_000,
    window: null,
  });
});

test("a window that is not a positive number is left unknown", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: {
      zero: providerModels([{ id: "m", contextWindow: 0 }]),
      negative: providerModels([{ id: "m", contextWindow: -1 }]),
      textual: providerModels([{ id: "m", contextWindow: "1000000" }]),
      missing: providerModels([{ id: "m" }]),
    },
  });
  const chat = createChatClient();

  for (const provider of ["zero", "negative", "textual", "missing"]) {
    const path = await writeAgentSession(
      agent,
      header(),
      assistant("a1", null, text("hi"), { model: "m", provider, usage: usage(1_000) }),
    );
    expect((await chat.snapshot(path)).context).toEqual({ tokens: 1_000, window: null });
  }
});

test("the agent dir is derived from the session path and needs models-store.json", async () => {
  // セッションの 3 つ上ではなく tmpdir 直下に models-store.json を置いても使わない。
  await writeCatalog(dir, {
    store: { p: providerModels([{ id: "m", contextWindow: 1_000_000 }]) },
  });
  const path = await writeSession(
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(1_000) }),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 1_000,
    window: null,
  });
});

test("the window follows the model on display, not the one that reported the usage", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: {
      "openai-codex": providerModels([{ id: "gpt-6", contextWindow: 256_000 }]),
      other: providerModels([{ id: "big", contextWindow: 1_000_000 }]),
    },
  });
  const path = await writeAgentSession(
    agent,
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), { model: "big", provider: "other", usage: usage(122_600) }),
    // 切り替え直後は、古いモデルで採った usage と新しいモデルの window が並ぶ。
    entry("model_change", "m1", "a1", { provider: "openai-codex", modelId: "gpt-6" }),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 122_600,
    window: 256_000,
  });
});

test("a tool-only assistant still reports the usage of the turn", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "run it"),
    assistant(
      "a1",
      "u1",
      [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
      { usage: usage(9_000), stopReason: "toolUse" },
    ),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages).toHaveLength(1);
  expect(snapshot.context).toEqual({ tokens: 9_000, window: null });
});

test("an all-zero usage is not a context reading", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    }),
  );

  expect((await createChatClient().snapshot(path)).context).toBeNull();
});

test("the usage total falls back to the sum of its parts", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), {
      usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0 },
    }),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 1_500,
    window: null,
  });
});

test("an aborted or failed turn does not report usage", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("ok"), { usage: usage(4_000), stopReason: "endTurn" }),
    user("u2", "a1", "more"),
    assistant("a2", "u2", text("partial"), { usage: usage(9_000), stopReason: "aborted" }),
    user("u3", "a2", "retry"),
    assistant("a3", "u3", text("failed"), { usage: usage(9_000), stopReason: "error" }),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 4_000,
    window: null,
  });
});

test("a compaction makes the earlier usage unknowable until the next answer", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), { usage: usage(122_600) }),
    entry("compaction", "c1", "a1", {
      summary: "so far",
      firstKeptEntryId: "u1",
      tokensBefore: 122_600,
    }),
  );

  expect((await createChatClient().snapshot(path)).context).toBeNull();

  await writeFile(
    path,
    [
      user("u2", "c1", "continue"),
      assistant("a2", "u2", text("done"), { usage: usage(3_000) }),
      "",
    ].join("\n"),
    { flag: "a" },
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 3_000,
    window: null,
  });
});

test("a compaction replaces the history before firstKeptEntryId", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    user("u2", "a1", "again"),
    assistant("a2", "u2", text("done")),
    entry("compaction", "c1", "a2", {
      summary: "the user said hello",
      firstKeptEntryId: "u2",
      tokensBefore: 212_959,
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  // 圧縮より前の会話はモデルの文脈にもう無い。表示もそれに合わせる。
  expect(snapshot.messages.map((message) => message.id)).toEqual(["u2", "a2"]);
  expect(snapshot.compaction).toEqual({
    at: Date.parse("2026-01-01T00:00:01.000Z"),
    tokensBefore: 212_959,
    summary: "the user said hello",
    index: 2,
  });
});

test("a compaction is placed before the messages that came after it", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    user("u2", "a1", "again"),
    assistant("a2", "u2", text("done")),
    entry("compaction", "c1", "a2", {
      summary: "the user said hello",
      firstKeptEntryId: "u2",
      tokensBefore: 212_959,
    }),
    user("u3", "c1", "after the compaction"),
    assistant("a3", "u3", text("still here")),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.id)).toEqual(["u2", "a2", "u3", "a3"]);
  expect(snapshot.compaction?.index).toBe(2);
});

test("a compaction that points outside the branch keeps the whole history", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", {
      summary: "so far",
      firstKeptEntryId: "gone",
      tokensBefore: 122_600,
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  // 要約だけ出して窓がずれるより、全体を出す。
  expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  expect(snapshot.compaction).toBeNull();
});

test("a compaction without a summary is not shown", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", { summary: "", firstKeptEntryId: "u1" }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  expect(snapshot.compaction).toBeNull();
});

test("a compaction without tokensBefore still windows the history", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    user("u2", "a1", "again"),
    entry("compaction", "c1", "u2", { summary: "so far", firstKeptEntryId: "u2" }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.compaction).toEqual({
    at: Date.parse("2026-01-01T00:00:01.000Z"),
    tokensBefore: null,
    summary: "so far",
    index: 1,
  });
  expect(snapshot.messages.map((message) => message.id)).toEqual(["u2"]);
});

test("only the newest compaction is shown", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", {
      summary: "first summary",
      firstKeptEntryId: "u1",
      tokensBefore: 100_000,
    }),
    user("u2", "c1", "again"),
    assistant("a2", "u2", text("done")),
    entry("compaction", "c2", "a2", {
      summary: "second summary",
      firstKeptEntryId: "u2",
      tokensBefore: 212_959,
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.compaction?.summary).toBe("second summary");
  expect(snapshot.compaction?.tokensBefore).toBe(212_959);
  expect(snapshot.compaction?.index).toBe(2);
  expect(snapshot.messages.map((message) => message.id)).toEqual(["u2", "a2"]);
});

test("a broken newest compaction is not replaced by an older one", async () => {
  const missingKeptId = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", {
      summary: "first summary",
      firstKeptEntryId: "u1",
      tokensBefore: 100_000,
    }),
    user("u2", "c1", "again"),
    // 最新の compaction には firstKeptEntryId が無い。c1 は使えるが遡らない。
    entry("compaction", "c2", "u2", { summary: "second summary" }),
  );
  const missingSummary = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", {
      summary: "first summary",
      firstKeptEntryId: "u1",
      tokensBefore: 100_000,
    }),
    user("u2", "c1", "again"),
    entry("compaction", "c2", "u2", { firstKeptEntryId: "u2" }),
  );

  for (const path of [missingKeptId, missingSummary]) {
    const snapshot = await createChatClient().snapshot(path);

    expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(snapshot.compaction).toBeNull();
  }
});

test("a newest compaction whose kept entry is gone is not replaced by an older one", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    entry("compaction", "c1", "a1", {
      summary: "first summary",
      firstKeptEntryId: "u1",
      tokensBefore: 100_000,
    }),
    user("u2", "c1", "again"),
    entry("compaction", "c2", "u2", {
      summary: "second summary",
      firstKeptEntryId: "gone",
      tokensBefore: 212_959,
    }),
  );

  const snapshot = await createChatClient().snapshot(path);

  expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  expect(snapshot.compaction).toBeNull();
});

test("the size limits apply to the windowed history", async () => {
  const lines = [header()];
  let parentId: string | null = null;
  for (let index = 0; index < 600; index += 1) {
    const id = `u${index}`;
    lines.push(user(id, parentId, `message ${index}`));
    parentId = id;
  }
  lines.push(
    entry("compaction", "c1", parentId, {
      summary: "so far",
      firstKeptEntryId: "u50",
      tokensBefore: 212_959,
    }),
  );
  const path = await writeSession(...lines);

  const snapshot = await createChatClient().snapshot(path);

  // 窓には 550 件ある。上限は窓のあとに効く。
  expect(snapshot.compaction?.summary).toBe("so far");
  expect(snapshot.messages).toHaveLength(500);
  expect(snapshot.messages[0]?.text).toBe("message 100");
  expect(snapshot.messages.at(-1)?.text).toBe("message 599");
  expect(snapshot.truncated).toBe(true);
});

test("a context edit also makes the earlier usage unknowable", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), { usage: usage(122_600) }),
    entry("context_edit", "e1", "a1", { targetId: "u1", replacement: null }),
    user("u2", "e1", "next"),
  );

  expect((await createChatClient().snapshot(path)).context).toBeNull();
});

test("usage outside the active branch is ignored", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "start"),
    assistant("a1", "u1", text("kept"), { usage: usage(50_000) }),
    user("u2", "a1", "branch A"),
    assistant("a2", "u2", text("abandoned"), { usage: usage(200_000) }),
    // /tree で u1 ではなく a1 から選び直した状態。末尾が新しい枝になる。
    user("u3", "a1", "branch B"),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: 50_000,
    window: null,
  });
});

test("the window is shown before the first usage arrives", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: { p: providerModels([{ id: "m", contextWindow: 1_000_000 }]) },
  });
  const path = await writeAgentSession(
    agent,
    header(),
    entry("model_change", "m1", null, { provider: "p", modelId: "m" }),
    user("u1", "m1", "hello"),
  );

  expect((await createChatClient().snapshot(path)).context).toEqual({
    tokens: null,
    window: 1_000_000,
  });
});

test("the context is folded into the four states the contract allows", async () => {
  const agent = agentDir();
  await writeCatalog(agent, {
    store: { p: providerModels([{ id: "m", contextWindow: 100_000 }]) },
  });
  const chat = createChatClient();

  const both = await writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(1_000) }),
  );
  const windowOnly = await writeAgentSession(
    agent,
    header(),
    entry("model_change", "m1", null, { provider: "p", modelId: "m" }),
  );
  const tokensOnly = await writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "gone", usage: usage(1_000) }),
  );
  const neither = await writeAgentSession(agent, header(), user("u1", null, "hello"));

  expect((await chat.snapshot(both)).context).toEqual({ tokens: 1_000, window: 100_000 });
  expect((await chat.snapshot(windowOnly)).context).toEqual({ tokens: null, window: 100_000 });
  expect((await chat.snapshot(tokensOnly)).context).toEqual({ tokens: 1_000, window: null });
  // 材料が無いときだけ null。{ tokens: null, window: null } は返さない。
  expect((await chat.snapshot(neither)).context).toBeNull();
});

test("the catalog is resolved once per agent dir", async () => {
  let loads = 0;
  const chat = createChatClient({
    sessionAgentDir: async () => "/agent",
    loadCatalog: async () => {
      loads += 1;
      return { contextWindow: () => 1_000_000 };
    },
  });
  const one = await writeSession(
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(1_000) }),
  );
  const two = await writeSession(
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(2_000) }),
  );

  expect((await chat.snapshot(one)).context).toEqual({ tokens: 1_000, window: 1_000_000 });
  expect((await chat.snapshot(two)).context).toEqual({ tokens: 2_000, window: 1_000_000 });
  expect(loads).toBe(1);
});

test("a catalog written after the first read is not picked up", async () => {
  const agent = agentDir();
  await mkdir(join(agent, "sessions", "slug"), { recursive: true });
  const path = await writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(1_000) }),
  );
  const chat = createChatClient();

  expect((await chat.snapshot(path)).context).toEqual({ tokens: 1_000, window: null });

  // 起動後に足したプロバイダや override は BFF の再起動まで反映しない。
  await writeCatalog(agent, {
    store: { p: providerModels([{ id: "m", contextWindow: 1_000_000 }]) },
  });
  expect((await chat.snapshot(path)).context).toEqual({ tokens: 1_000, window: null });
});
