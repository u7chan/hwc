import { expect, test } from "bun:test";
import { createQuestionAnswerer } from "./answer-question";
import type { ChatPending, ChatSnapshot } from "./chat/contract";
import { MAX_TEXT_BYTES } from "./herdr/panes";

const PANE = "w1:p1";
const SESSION = "session-1";

const question = (toolUseId: string): Extract<ChatPending, { kind: "question" }> => ({
  kind: "question",
  toolUseId,
  tool: "AskUserQuestion",
  questions: [
    {
      question: "好きな色は？",
      header: "色",
      multiSelect: false,
      options: [
        { label: "赤", description: null },
        { label: "青", description: null },
      ],
    },
  ],
});

const request = (toolUseId = "t1") => ({
  toolUseId,
  answers: [{ question: "好きな色は？", labels: ["青"] }],
});

// 取得ごとに、決めた順で pending を返す。尽きたら最後の値を返し続ける。
type Read = ChatPending | undefined | Error;

function setup(
  reads: Read[] | ((sessionId: string, count: number) => Read),
  failures: { keys?: Error; send?: Error } = {},
) {
  const calls: string[] = [];
  const sent: string[] = [];
  let clock = 0;
  let index = 0;
  const counts = new Map<string, number>();
  const next = (sessionId: string): Read => {
    if (typeof reads === "function") {
      const count = counts.get(sessionId) ?? 0;
      counts.set(sessionId, count + 1);
      return reads(sessionId, count);
    }
    const value = reads[Math.min(index, reads.length - 1)];
    index += 1;
    return value;
  };
  const answerer = createQuestionAnswerer(
    {
      panes: {
        sendKeys: async ({ paneId, keys }) => {
          calls.push(`keys:${paneId}:${keys.join("+")}`);
          if (failures.keys) throw failures.keys;
        },
        send: async ({ paneId, text, submit }) => {
          calls.push(`send:${paneId}:${submit}`);
          sent.push(text);
          if (failures.send) throw failures.send;
        },
      },
      chat: {
        snapshot: async (sessionId) => {
          calls.push("read");
          const value = next(sessionId);
          if (value instanceof Error) throw value;
          return { pending: value } as ChatSnapshot;
        },
      },
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollIntervalMs: 100,
      settleTimeoutMs: 1_000,
      doneTtlMs: 30_000,
    },
  );
  const answer = (overrides: Partial<Parameters<typeof answerer.answer>[0]> = {}) =>
    answerer.answer({
      paneId: PANE,
      sessionId: overrides.paneId === undefined ? SESSION : `session-of-${overrides.paneId}`,
      blocked: true,
      request: request(),
      ...overrides,
    });
  return { answer, calls, sent, advance: (ms: number) => (clock += ms) };
}

test("Esc closes the dialog first, then the answer is sent as an ordinary message", async () => {
  const { answer, calls, sent } = setup([
    question("t1"),
    question("t1"),
    question("t1"),
    undefined,
  ]);

  expect(await answer()).toEqual({ ok: true });

  // 読む→Esc→（待ちが消えるまで読む）→本文。Esc より先に本文を送らない。
  expect(calls).toEqual(["read", `keys:${PANE}:esc`, "read", "read", "read", `send:${PANE}:true`]);
  expect(sent).toEqual(["質問への回答:\n好きな色は？: 青"]);
});

test("the body uses the question the pane is waiting on, not the client's wording", async () => {
  const { answer, sent } = setup([question("t1"), undefined]);

  await answer({
    request: { toolUseId: "t1", answers: [{ question: "好きな色は？", text: "  緑\nに近い青 " }] },
  });

  expect(sent).toEqual(["質問への回答:\n好きな色は？: 緑 に近い青"]);
});

test.each([
  ["Herdr does not report blocked", { blocked: false }, [question("t1")]],
  ["nothing is pending", {}, [undefined]],
  [
    "the pending wait is not a question",
    {},
    [{ kind: "tool", toolUseId: "t1", tool: "Bash", summary: null } as const],
  ],
  ["another question is pending", {}, [question("t2")]],
])("nothing is sent when %s", async (_name, overrides, reads) => {
  const { answer, calls } = setup([...reads]);

  expect(await answer(overrides)).toEqual({ ok: false, status: 409, error: "not_waiting" });
  expect(calls.filter((call) => call !== "read")).toEqual([]);
});

test("nothing is sent when the pending wait cannot be read", async () => {
  const { answer, calls } = setup([new Error("transcript unreadable")]);

  expect(await answer()).toEqual({ ok: false, status: 502, error: "pending_unavailable" });
  expect(calls).toEqual(["read"]);
});

test.each([
  ["an answer that is not an option", [{ question: "好きな色は？", labels: ["緑"] }]],
  ["an empty choice", [{ question: "好きな色は？", labels: [] }]],
  ["blank free text", [{ question: "好きな色は？", text: "   " }]],
  ["an answer to another question", [{ question: "別の質問", labels: ["赤"] }]],
])("%s is refused before the dialog is touched", async (_name, answers) => {
  const { answer, calls } = setup([question("t1")]);

  expect(await answer({ request: { toolUseId: "t1", answers } })).toEqual({
    ok: false,
    status: 400,
    error: "invalid_answer",
  });
  expect(calls).toEqual(["read"]);
});

test("a body over the input limit is refused before the dialog is touched", async () => {
  const { answer, calls } = setup([question("t1")]);

  const result = await answer({
    request: {
      toolUseId: "t1",
      answers: [{ question: "好きな色は？", text: "あ".repeat(MAX_TEXT_BYTES / 3) }],
    },
  });

  expect(result).toEqual({ ok: false, status: 413, error: "answer_too_long" });
  expect(calls).toEqual(["read"]);
});

test("a body that fits exactly is sent", async () => {
  const { answer, sent } = setup([question("t1"), undefined]);
  const prefix = "質問への回答:\n好きな色は？: ";
  const free = "a".repeat(MAX_TEXT_BYTES - new TextEncoder().encode(prefix).length);

  expect(
    await answer({
      request: { toolUseId: "t1", answers: [{ question: "好きな色は？", text: free }] },
    }),
  ).toEqual({ ok: true });
  expect(new TextEncoder().encode(sent[0]!).length).toBe(MAX_TEXT_BYTES);
});

test("the answer is not sent when the wait outlives the timeout", async () => {
  const { answer, calls } = setup([question("t1")]);

  expect(await answer()).toEqual({ ok: false, status: 502, error: "close_timeout" });
  expect(calls).toContain(`keys:${PANE}:esc`);
  expect(calls.some((call) => call.startsWith("send:"))).toBe(false);
});

test("the answer is not sent when another question has taken the place", async () => {
  const { answer, calls } = setup([question("t1"), question("t2")]);

  expect(await answer()).toEqual({ ok: false, status: 409, error: "question_changed" });
  expect(calls.some((call) => call.startsWith("send:"))).toBe(false);
});

test("the answer is not sent when the conversation cannot be read while waiting", async () => {
  const { answer, calls } = setup([question("t1"), new Error("gone")]);

  expect(await answer()).toEqual({ ok: false, status: 502, error: "pending_unavailable" });
  expect(calls.some((call) => call.startsWith("send:"))).toBe(false);
});

test("a failure to send Esc stops before waiting or sending", async () => {
  const { answer, calls } = setup([question("t1")], { keys: new Error("socket closed") });

  expect(await answer()).toEqual({ ok: false, status: 502, error: "close_failed" });
  expect(calls).toEqual(["read", `keys:${PANE}:esc`]);
});

test("a failure to send the answer is reported without a retry", async () => {
  const { answer, calls } = setup([question("t1"), undefined], {
    send: new Error("socket closed"),
  });

  expect(await answer()).toEqual({ ok: false, status: 502, error: "send_failed" });
  expect(calls.filter((call) => call.startsWith("send:"))).toHaveLength(1);
});

test("a repeat of a finished request is answered 200 without touching the pane again", async () => {
  const { answer, calls } = setup([question("t1"), undefined]);
  await answer();
  const before = calls.length;

  // 完了後は blocked でも pending でもない。それでも同じ要求は成功として返す。
  expect(await answer({ blocked: false })).toEqual({ ok: true });
  expect(calls).toHaveLength(before);
});

test("a finished request is forgotten after its lifetime", async () => {
  const { answer, advance } = setup([question("t1"), undefined]);
  await answer();

  advance(30_001);

  expect(await answer({ blocked: false })).toEqual({
    ok: false,
    status: 409,
    error: "not_waiting",
  });
});

test("a different question after a finished one is not mistaken for a repeat", async () => {
  const { answer } = setup([question("t1"), undefined]);
  await answer();

  expect(await answer({ blocked: false, request: request("t2") })).toEqual({
    ok: false,
    status: 409,
    error: "not_waiting",
  });
});

test("a failed attempt is not remembered, so the same request can be tried again", async () => {
  const { answer } = setup([question("t1")]);
  expect((await answer()).ok).toBe(false);

  expect(await answer()).toMatchObject({ ok: false, status: 502 });
});

test("a double tap while the first request runs shares its result and sends once", async () => {
  const { answer, calls } = setup([question("t1"), question("t1"), undefined]);

  const [first, second] = await Promise.all([answer(), answer()]);

  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: true });
  expect(calls.filter((call) => call.startsWith("keys:"))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith("send:"))).toHaveLength(1);
});

test("a different request on the same pane is refused while one is running", async () => {
  const { answer } = setup([question("t1"), question("t1"), undefined]);

  const [first, second] = await Promise.all([answer(), answer({ request: request("t2") })]);

  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: false, status: 409, error: "in_progress" });
});

test("panes do not wait for each other", async () => {
  const { answer, calls } = setup((_session, count) => (count < 2 ? question("t1") : undefined));

  const [first, second] = await Promise.all([answer(), answer({ paneId: "w1:p2" })]);

  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: true });
  expect(calls.filter((call) => call.startsWith("keys:"))).toHaveLength(2);
});
