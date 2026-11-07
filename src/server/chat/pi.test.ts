import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ChatReader,
  ChatUnavailableError,
  createChatClient as createRealChatClient,
} from "./pi";

function createChatClient(options: Parameters<typeof createRealChatClient>[0] = {}) {
  return createRealChatClient({ loadPiModels: async () => [], ...options });
}

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
  expect(snapshot.usage).toEqual({
    input: 9_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: null,
  });
});

test("an all-zero usage is not a context reading", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.context).toBeNull();
  expect(snapshot.usage).toBeUndefined();
});

test("the usage total falls back to the sum of its parts", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi"), {
      usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0 },
    }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.context).toEqual({
    tokens: 1_500,
    window: null,
  });
  expect(snapshot.usage).toEqual({
    input: 1_000,
    output: 200,
    cacheRead: 300,
    cacheWrite: 0,
    reasoning: null,
  });
});

test("a failed turn stays in the conversation as an error row", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    // pi は失敗したターンを本文の無い assistant として書く。行が無いと、送った
    // メッセージに何も返らないまま idle に戻り、届いていないように見える。
    assistant("a1", "u1", [], {
      stopReason: "error",
      errorMessage: '429: {"type":"server_error","message":"at capacity"}',
    }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_700_000_000_000 },
    {
      id: "a1:error",
      role: "error",
      text: '429: {"type":"server_error","message":"at capacity"}',
      at: 1_700_000_000_001,
    },
  ]);
});

test("an aborted turn is not an error row", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", [], { stopReason: "aborted", errorMessage: "Aborted" }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_700_000_000_000 },
  ]);
});

test("a failed turn keeps the text it had written", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("half an answer"), {
      stopReason: "error",
      errorMessage: "Request timed out.",
    }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "hello"],
    ["agent", "half an answer"],
    ["error", "Request timed out."],
  ]);
});

test("identical failed attempts are folded into one row", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", [], { stopReason: "error", errorMessage: "429: busy" }),
    entry("context_edit", "x1", "a1", {}),
    assistant("a2", "x1", [], { stopReason: "error", errorMessage: "429: busy" }),
  );

  const snapshot = await createChatClient().snapshot(path);
  // 自動リトライの試行ごとに行を増やさない。回数は count に残す。
  expect(snapshot.messages).toEqual([
    { id: "u1", role: "user", text: "hello", at: 1_700_000_000_000 },
    { id: "a1:error", role: "error", text: "429: busy", at: 1_700_000_000_001, count: 2 },
  ]);
});

test("a different failure or an answer in between starts a new row", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", [], { stopReason: "error", errorMessage: "429: busy" }),
    assistant("a2", "a1", [], { stopReason: "error", errorMessage: "Request timed out." }),
    assistant("a3", "a2", text("half an answer")),
    assistant("a4", "a3", [], { stopReason: "error", errorMessage: "429: busy" }),
  );

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.messages.map((message) => [message.text, message.count ?? 1])).toEqual([
    ["hello", 1],
    ["429: busy", 1],
    ["Request timed out.", 1],
    ["half an answer", 1],
    ["429: busy", 1],
  ]);
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

  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.context).toEqual({
    tokens: 4_000,
    window: null,
  });
  expect(snapshot.usage?.input).toBe(4_000);
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

  const compacted = await createChatClient().snapshot(path);
  expect(compacted.context).toBeNull();
  expect(compacted.usage).toBeUndefined();

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

test("missing or invalid usage parts are unknown and do not reuse earlier parts", async () => {
  const path = await writeSession(
    header(),
    assistant("a1", null, text("first"), { usage: usage(50) }),
    assistant("a2", "a1", text("second"), {
      usage: { totalTokens: 100, input: 80, output: -1, cacheRead: "bad" },
    }),
  );
  const snapshot = await createChatClient().snapshot(path);
  expect(snapshot.context?.tokens).toBe(100);
  expect(snapshot.usage).toEqual({
    input: 80,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
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

test("an error row before the compaction counts toward the rule position", async () => {
  const path = await writeSession(
    header(),
    user("u1", null, "hello"),
    assistant("a1", "u1", text("hi")),
    user("u2", "a1", "again"),
    assistant("a2", "u2", [], { stopReason: "error", errorMessage: "429: busy" }),
    entry("compaction", "c1", "a2", { summary: "so far", firstKeptEntryId: "u1" }),
    assistant("a3", "c1", text("after")),
  );

  const snapshot = await createChatClient().snapshot(path);

  // 区切りは表示行の位置なので、error 行も 1 行として数える。
  expect(snapshot.compaction?.index).toBe(4);
  expect(snapshot.messages.map((message) => message.id)).toEqual([
    "u1",
    "a1",
    "u2",
    "a2:error",
    "a3",
  ]);
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

async function writeUsageSession(agent: string, tokens = 1_000): Promise<string> {
  return writeAgentSession(
    agent,
    header(),
    assistant("a1", null, text("hi"), { model: "m", provider: "p", usage: usage(tokens) }),
  );
}

const storedWindow = (window: number): unknown => ({
  p: providerModels([{ id: "m", contextWindow: window }]),
});

const overriddenWindow = (window: number): unknown => ({
  providers: { p: { modelOverrides: { m: { contextWindow: window } } } },
});

test("a catalog written after the first read is picked up without session changes", async () => {
  const agent = agentDir();
  const path = await writeUsageSession(agent);
  const chat = createChatClient();
  const before = await chat.snapshot(path);

  expect(before.context).toEqual({ tokens: 1_000, window: null });

  await writeCatalog(agent, { store: storedWindow(1_000_000) });
  const after = await chat.snapshot(path);

  expect(after.context).toEqual({ tokens: 1_000, window: 1_000_000 });
  expect(after.messages).toEqual(before.messages);
  expect(after.etag).not.toBe(before.etag);
  expect((await chat.snapshot(path)).etag).toBe(after.etag);
});

test("override additions, changes and removals follow the config without session changes", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: storedWindow(100_000) });
  const path = await writeUsageSession(agent);
  const chat = createChatClient();
  const before = await chat.snapshot(path);
  let previous = before;

  for (const [config, window] of [
    [overriddenWindow(200_000), 200_000],
    [overriddenWindow(1_000_000), 1_000_000],
    [{ providers: { p: { modelOverrides: {} } } }, 100_000],
    [overriddenWindow(300_000), 300_000],
  ] as const) {
    await writeCatalog(agent, { config });
    const current = await chat.snapshot(path);
    expect(current.context).toEqual({ tokens: 1_000, window });
    expect(current.messages).toEqual(before.messages);
    expect(current.etag).not.toBe(previous.etag);
    expect((await chat.snapshot(path)).etag).toBe(current.etag);
    previous = current;
  }

  await rm(join(agent, "models.json"));
  const removed = await chat.snapshot(path);
  expect(removed.context).toEqual({ tokens: 1_000, window: 100_000 });
  expect(removed.etag).not.toBe(previous.etag);
});

test.each([
  {
    change: "model addition",
    before: { p: providerModels([]) },
    after: storedWindow(100_000),
    window: 100_000,
  },
  { change: "provider addition", before: {}, after: storedWindow(100_000), window: 100_000 },
  {
    change: "model removal",
    before: storedWindow(100_000),
    after: { p: providerModels([]) },
    window: null,
  },
  { change: "provider removal", before: storedWindow(100_000), after: {}, window: null },
  {
    change: "window change",
    before: storedWindow(100_000),
    after: storedWindow(200_000),
    window: 200_000,
  },
])("a stored $change is reflected without session changes", async (change) => {
  const agent = agentDir();
  await writeCatalog(agent, { store: change.before });
  const path = await writeUsageSession(agent);
  const chat = createChatClient();
  const before = await chat.snapshot(path);

  await writeCatalog(agent, { store: change.after });
  const after = await chat.snapshot(path);

  expect(after.context).toEqual({ tokens: 1_000, window: change.window });
  expect(after.messages).toEqual(before.messages);
  expect(after.etag).not.toBe(before.etag);
  expect((await chat.snapshot(path)).etag).toBe(after.etag);
});

test("an override becomes usable only while its provider and model exist in the store", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: {}, config: overriddenWindow(1_000_000) });
  const path = await writeUsageSession(agent);
  const chat = createChatClient();

  expect((await chat.snapshot(path)).context?.window).toBeNull();
  await writeCatalog(agent, { store: storedWindow(100_000) });
  expect((await chat.snapshot(path)).context?.window).toBe(1_000_000);
  await writeCatalog(agent, { store: { p: providerModels([]) } });
  expect((await chat.snapshot(path)).context?.window).toBeNull();
});

test("a Pi model outside the stored catalog supplies its exact window and is cached per catalog", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: {} });
  const path = await writeUsageSession(agent);
  let calls = 0;
  const chat = createChatClient({
    loadPiModels: async (dir) => {
      expect(dir).toBe(agent);
      calls += 1;
      return [{ provider: "p", id: "m", window: 500_000 }];
    },
  });
  const first = await chat.snapshot(path);
  expect(first.context?.window).toBe(500_000);
  expect((await chat.snapshot(path)).etag).toBe(first.etag);
  expect(calls).toBe(1);
  await writeCatalog(agent, { store: {}, config: overriddenWindow(300_000) });
  await chat.snapshot(path);
  expect(calls).toBe(2);
});

test("Pi model fallback failure leaves chat intact and is retried", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: {} });
  const path = await writeUsageSession(agent);
  let calls = 0;
  const chat = createChatClient({
    loadPiModels: async () => {
      if (++calls === 1) throw new Error("unavailable");
      return [{ provider: "p", id: "m", window: 500_000 }];
    },
  });
  const first = await chat.snapshot(path);
  expect(first.context).toEqual({ tokens: 1_000, window: null });
  const next = await chat.snapshot(path);
  expect(next.context?.window).toBe(500_000);
  expect(next.etag).not.toBe(first.etag);
  expect(next.messages).toEqual(first.messages);
});

test("editing a comment-prefixed Pi config refreshes the fallback and etag", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: {} });
  const path = await writeUsageSession(agent);
  const config = join(agent, "models.json");
  const writeWindow = (window: number) =>
    writeFile(config, `\ufeff// Pi accepts this comment\n${JSON.stringify({ window })}`);
  let calls = 0;
  const chat = createChatClient({
    loadPiModels: async () => {
      calls += 1;
      const text = await readFile(config, "utf8");
      const data = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { window: number };
      return [{ provider: "p", id: "m", window: data.window }];
    },
  });
  await writeWindow(500_000);
  const before = await chat.snapshot(path);
  expect(before.context?.window).toBe(500_000);
  expect((await chat.snapshot(path)).etag).toBe(before.etag);
  expect(calls).toBe(1);
  await writeWindow(256_000);
  const after = await chat.snapshot(path);
  expect(after.context?.window).toBe(256_000);
  expect(after.etag).not.toBe(before.etag);
  expect(calls).toBe(2);
});

test("Pi model fallback works without a stored catalog and never mixes agent directories", async () => {
  const one = agentDir();
  const two = join(dir, "another-agent");
  const paths = await Promise.all([writeUsageSession(one), writeUsageSession(two)]);
  const chat = createChatClient({
    loadPiModels: async (dir) => [
      { provider: "p", id: "m", window: dir === one ? 500_000 : 256_000 },
    ],
  });
  expect((await chat.snapshot(paths[0]!)).context?.window).toBe(500_000);
  expect((await chat.snapshot(paths[1]!)).context?.window).toBe(256_000);
});

test("catalog reevaluation preserves the etag when the displayed window does not change", async () => {
  const agent = agentDir();
  const store = {
    p: providerModels([{ id: "m", contextWindow: 100_000 }]),
    other: providerModels([{ id: "m", contextWindow: 200_000 }]),
  };
  await writeCatalog(agent, { store });
  const path = await writeUsageSession(agent);
  const chat = createChatClient();
  const before = await chat.snapshot(path);

  for (const files of [
    { store },
    { store: { ...store, other: providerModels([{ id: "m", contextWindow: 300_000 }]) } },
    { config: { providers: { other: { modelOverrides: { m: { contextWindow: 400_000 } } } } } },
    { config: overriddenWindow(100_000) },
  ]) {
    await writeCatalog(agent, files);
    expect(await chat.snapshot(path)).toEqual(before);
  }
});

test.each(["in-place", "atomic rename"])(
  "same-size catalog updates are detected after %s with a restored mtime",
  async (method) => {
    const agent = agentDir();
    await writeCatalog(agent, { store: storedWindow(100_000) });
    const path = await writeUsageSession(agent);
    const chat = createChatClient();
    const file = join(agent, "models-store.json");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await utimes(file, fixedTime, fixedTime);
    const before = await chat.snapshot(path);
    const info = await stat(file);
    const target = method === "in-place" ? file : join(agent, "replacement.json");

    await writeFile(target, JSON.stringify(storedWindow(200_000)));
    await utimes(target, info.atime, info.mtime);
    if (target !== file) await rename(target, file);
    const after = await chat.snapshot(path);

    expect(after.context).toEqual({ tokens: 1_000, window: 200_000 });
    expect(after.etag).not.toBe(before.etag);
  },
);

test.each(["models-store.json", "models.json"])(
  "a transient read failure in %s is retried even when metadata is unchanged",
  async (name) => {
    const agent = agentDir();
    await writeCatalog(agent, {
      store: storedWindow(100_000),
      config: overriddenWindow(200_000),
    });
    const path = await writeUsageSession(agent);
    let failing = true;
    const chat = createChatClient({
      readCatalogFile: async (file) => {
        if (file === join(agent, name) && failing) throw new Error("temporarily unreadable");
        return readFile(file, "utf8");
      },
    });
    const before = await chat.snapshot(path);

    expect(before.context).toEqual({
      tokens: 1_000,
      window: name === "models-store.json" ? null : 100_000,
    });
    failing = false;
    const after = await chat.snapshot(path);

    expect(after.context).toEqual({ tokens: 1_000, window: 200_000 });
    expect(after.messages).toEqual(before.messages);
    expect(after.etag).not.toBe(before.etag);
  },
);

test.each(
  ["models-store.json", "models.json"].flatMap((name) =>
    ["missing", "invalid JSON", "directory"].map((failure) => ({ name, failure })),
  ),
)("$name becoming $failure does not stop chat and recovers", async ({ name, failure }) => {
  const agent = agentDir();
  const catalog = { store: storedWindow(100_000), config: overriddenWindow(200_000) };
  await writeCatalog(agent, catalog);
  const path = await writeUsageSession(agent);
  const chat = createChatClient();
  const before = await chat.snapshot(path);
  const file = join(agent, name);

  await rm(file);
  if (failure === "invalid JSON") await writeFile(file, "{");
  if (failure === "directory") await mkdir(file);
  const failed = await chat.snapshot(path);

  expect(failed.context).toEqual({
    tokens: 1_000,
    window: name === "models-store.json" ? null : 100_000,
  });
  expect(failed.messages).toEqual(before.messages);
  expect(failed.etag).not.toBe(before.etag);
  expect((await chat.snapshot(path)).etag).toBe(failed.etag);

  await rm(file, { recursive: true, force: true });
  await writeCatalog(agent, catalog);
  expect(await chat.snapshot(path)).toEqual(before);
});

test("a window can appear and disappear before the first usage without changing the session", async () => {
  const agent = agentDir();
  const path = await writeAgentSession(
    agent,
    header(),
    entry("model_change", "m1", null, { provider: "p", modelId: "m" }),
  );
  const chat = createChatClient();
  const before = await chat.snapshot(path);
  expect(before.context).toBeNull();

  await writeCatalog(agent, { store: storedWindow(100_000) });
  const known = await chat.snapshot(path);
  expect(known.context).toEqual({ tokens: null, window: 100_000 });
  expect(known.etag).not.toBe(before.etag);

  await rm(join(agent, "models-store.json"));
  const unknown = await chat.snapshot(path);
  expect(unknown.context).toBeNull();
  expect(unknown.etag).not.toBe(known.etag);
});

test("sessions share updated catalogs only within the same agent dir", async () => {
  const one = agentDir();
  const two = join(dir, "another-agent");
  await writeCatalog(one, { store: storedWindow(100_000), config: overriddenWindow(200_000) });
  await writeCatalog(two, { store: storedWindow(300_000), config: overriddenWindow(400_000) });
  const paths = [
    await writeUsageSession(one, 1_000),
    await writeUsageSession(one, 2_000),
    await writeUsageSession(two, 3_000),
  ];
  const chat = createChatClient();
  const before = await Promise.all(paths.map((path) => chat.snapshot(path)));

  expect(before.map((snapshot) => snapshot.context?.window)).toEqual([200_000, 200_000, 400_000]);
  await writeCatalog(one, { config: overriddenWindow(500_000) });
  const after = await Promise.all(paths.map((path) => chat.snapshot(path)));

  expect(after.map((snapshot) => snapshot.context)).toEqual([
    { tokens: 1_000, window: 500_000 },
    { tokens: 2_000, window: 500_000 },
    { tokens: 3_000, window: 400_000 },
  ]);
  expect(after[0]?.etag).not.toBe(before[0]?.etag);
  expect(after[1]?.etag).not.toBe(before[1]?.etag);
  expect(after[2]).toEqual(before[2]);
});

test("concurrent sessions share catalog reads and only changed files are read again", async () => {
  const agent = agentDir();
  await writeCatalog(agent, { store: storedWindow(100_000), config: overriddenWindow(200_000) });
  const paths = [await writeUsageSession(agent), await writeUsageSession(agent, 2_000)];
  const reads: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = createChatClient({
    readCatalogFile: async (file) => {
      reads.push(file);
      await gate;
      return readFile(file, "utf8");
    },
  });
  const pending = Promise.all(paths.map((path) => chat.snapshot(path)));
  await Bun.sleep(20);
  release();
  expect((await pending).map((snapshot) => snapshot.context?.window)).toEqual([200_000, 200_000]);
  expect(reads.toSorted()).toEqual(
    [join(agent, "models-store.json"), join(agent, "models.json")].toSorted(),
  );

  await Promise.all(paths.map((path) => chat.snapshot(path)));
  expect(reads).toHaveLength(2);

  await writeCatalog(agent, { config: overriddenWindow(300_000) });
  const updated = await Promise.all(paths.map((path) => chat.snapshot(path)));
  expect(updated.map((snapshot) => snapshot.context?.window)).toEqual([300_000, 300_000]);
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)).toBe(join(agent, "models.json"));
});
