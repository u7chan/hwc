import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      return { etag: reader.etagPrefix, messages: [], model: null, effort: null, truncated: false };
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
