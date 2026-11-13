import { expect, test } from "bun:test";
import { composeInputText } from "../../shared/attachments";
import { type CodexReader } from "../codex";
import { createCodexChatClient } from "./codex";
import { MAX_CHAT_BYTES } from "./limit";

const thread = { id: "thread_demo", model: "beam", reasoningEffort: "high" };
const user = (id: string, text: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text }],
  startedAtMs: 1100,
});
const agent = (id: string, text: string) => ({ type: "agentMessage", id, text });
const turn = (id: string, ...items: unknown[]) => ({ id, items, startedAt: 1 });

function clientFor(options: { thread?: unknown; pages?: unknown[] } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const read: CodexReader = async (_directory, run) => {
    let page = 0;
    return run(async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: options.thread ?? thread };
      if (method === "thread/turns/list") {
        return options.pages?.[page++] ?? { data: [], nextCursor: null };
      }
      throw new Error("Only read-only methods are allowed");
    });
  };
  return { client: createCodexChatClient({ read }), calls };
}

test("Codex text becomes chat messages without tools, reasoning, system input, or compaction internals", async () => {
  const { client, calls } = clientFor({
    pages: [
      {
        data: [
          turn(
            "t1",
            user("u1", "hello"),
            { type: "reasoning", id: "r1", text: "private reasoning" },
            { type: "commandExecution", id: "c1", command: "secret" },
            { type: "systemMessage", id: "s1", text: "system" },
            agent("a1", "**answer**"),
            { type: "contextCompaction", id: "c2" },
          ),
        ],
        nextCursor: null,
      },
    ],
  });
  const snapshot = await client.snapshot(thread.id);
  expect(snapshot.messages).toEqual([
    { id: "t1/u1", role: "user", text: "hello", at: 1100 },
    { id: "t1/a1", role: "agent", text: "**answer**", at: 1000 },
  ]);
  expect(snapshot).toMatchObject({
    model: "beam",
    effort: "high",
    context: null,
    compaction: null,
    truncated: false,
  });
  expect(calls.map((call) => call.method)).toEqual(["thread/read", "thread/turns/list"]);
  expect(calls[1]?.params).toMatchObject({ itemsView: "full", sortDirection: "desc" });
});

test("newest-first turn pages are returned in conversation order with unique message ids", async () => {
  const { client, calls } = clientFor({
    pages: [
      {
        data: [turn("t3", agent("a", "third")), turn("t2", agent("a", "second"))],
        nextCursor: "older",
      },
      { data: [turn("t1", user("u", "first"))], nextCursor: null },
    ],
  });
  const snapshot = await client.snapshot(thread.id);
  expect(snapshot.messages.map((message) => message.text)).toEqual(["first", "second", "third"]);
  expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(3);
  expect(calls[2]?.params.cursor).toBe("older");
  expect(snapshot.truncated).toBe(false);
});

test("Codex user attachment annotations are stripped, including image-only sends", async () => {
  const name = "pasted-20260101-090000.png";
  const { client } = clientFor({
    pages: [
      {
        data: [
          turn("t1", user("u1", composeInputText("", [`/private/attachments/${name}`])), {
            type: "userMessage",
            id: "u2",
            content: [{ type: "localImage", path: "/private/image.png" }],
          }),
        ],
      },
    ],
  });
  const snapshot = await client.snapshot(thread.id);
  expect(snapshot.messages[0]).toMatchObject({ text: "", attachments: [{ name, size: null }] });
  expect(snapshot.messages[1]?.text).toBe("[画像]");
  expect(JSON.stringify(snapshot)).not.toContain("/private");
});

test("message timestamps prefer item anchors and fall back to turn seconds", async () => {
  const { client } = clientFor({
    pages: [
      {
        data: [
          turn(
            "t1",
            { ...agent("a1", "one"), startedAtMs: 1234, completedAtMs: 2345 },
            { ...agent("a2", "two"), completedAtMs: 3456 },
            agent("a3", "three"),
          ),
        ],
      },
    ],
  });
  expect((await client.snapshot(thread.id)).messages.map((message) => message.at)).toEqual([
    1234, 3456, 1000,
  ]);
});

test("empty threads and unknown model metadata remain empty rather than fabricated", async () => {
  const { client } = clientFor({ thread: { id: thread.id } });
  expect(await client.snapshot(thread.id)).toMatchObject({
    messages: [],
    model: null,
    effort: null,
    truncated: false,
  });
});

test("etag changes only when the thread identity or displayed snapshot changes", async () => {
  let selected = thread;
  let text = "answer";
  const read: CodexReader = async (_directory, run) =>
    run(async (method, params) =>
      method === "thread/read"
        ? { thread: { ...selected, id: params.threadId } }
        : { data: [turn("t1", agent("a1", text))] },
    );
  const client = createCodexChatClient({ read });
  const first = await client.snapshot(thread.id);
  expect((await client.snapshot(thread.id)).etag).toBe(first.etag);
  selected = { ...thread, reasoningEffort: "low" };
  expect((await client.snapshot(thread.id)).etag).not.toBe(first.etag);
  selected = thread;
  text = "new answer";
  expect((await client.snapshot(thread.id)).etag).not.toBe(first.etag);
  text = "answer";
  expect((await client.snapshot("other_thread")).etag).not.toBe(first.etag);
});

test("Codex keeps only the latest 500 messages and stops reading older pages", async () => {
  const { client, calls } = clientFor({
    pages: [
      {
        data: [
          turn("t1", ...Array.from({ length: 501 }, (_, i) => agent(`a${i}`, `message ${i}`))),
        ],
        nextCursor: "older",
      },
    ],
  });
  const snapshot = await client.snapshot(thread.id);
  expect(snapshot.messages).toHaveLength(500);
  expect(snapshot.messages[0]?.text).toBe("message 1");
  expect(snapshot.truncated).toBe(true);
  expect(calls).toHaveLength(2);
});

test("Codex applies the shared byte limit to the most recent messages", async () => {
  const { client } = clientFor({
    pages: [
      { data: [turn("t1", agent("old", "x".repeat(MAX_CHAT_BYTES)), agent("new", "latest"))] },
    ],
  });
  const snapshot = await client.snapshot(thread.id);
  expect(snapshot.messages.map((message) => message.text)).toEqual(["latest"]);
  expect(snapshot.truncated).toBe(true);
});

test.each([{}, { data: null }, { data: [null] }, { data: [], nextCursor: 1 }])(
  "malformed Codex history is unavailable: %j",
  async (page) => {
    const { client } = clientFor({ pages: [page] });
    await expect(client.snapshot(thread.id)).rejects.toThrow();
  },
);

test("a response for a different Codex thread is rejected", async () => {
  const { client } = clientFor({ thread: { id: "other_thread" } });
  await expect(client.snapshot(thread.id)).rejects.toThrow();
});

test("a repeated page cursor cannot loop indefinitely", async () => {
  const page = { data: [], nextCursor: "same" };
  const { client } = clientFor({ pages: [page, page] });
  await expect(client.snapshot(thread.id)).rejects.toThrow("cursor did not advance");
});

test("tool-only history is bounded even without reaching the message limit", async () => {
  const { client, calls } = clientFor({
    pages: Array.from({ length: 30 }, (_, i) => ({
      data: [turn(`t${i}`, { type: "commandExecution", id: "tool" })],
      nextCursor: `page${i}`,
    })),
  });
  expect(await client.snapshot(thread.id)).toMatchObject({ messages: [], truncated: true });
  expect(calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(25);
});

test("concurrent reads of one Codex thread share a request, and failures can be retried", async () => {
  let count = 0;
  let succeed = false;
  const read: CodexReader = async (_directory, run) => {
    count += 1;
    await Bun.sleep(5);
    if (!succeed) throw new Error("unavailable");
    return run(async (method) => (method === "thread/read" ? { thread } : { data: [] }));
  };
  const client = createCodexChatClient({ read });
  const results = await Promise.allSettled([
    client.snapshot(thread.id),
    client.snapshot(thread.id),
  ]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(count).toBe(1);
  succeed = true;
  expect((await client.snapshot(thread.id)).messages).toEqual([]);
  expect(count).toBe(2);
});
