import { expect, test } from "bun:test";
import type { AnswerRequest } from "../shared/answer";
import { createAskAnswerer } from "./answer-ask";
import type { AskAnswer, AskPending } from "./chat/pi-ask";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const OPTIONS: AskPending = {
  id: ID,
  question: "どれにしますか？",
  options: ["赤", "青"],
};
const FREE: AskPending = {
  id: ID,
  question: "自由に書いてください",
  options: null,
};

function request(answers: AnswerRequest["answers"], toolUseId = ID): AnswerRequest {
  return { toolUseId, answers };
}

function option(label = "青"): AnswerRequest {
  return request([{ question: OPTIONS.question, labels: [label] }]);
}

function harness(
  options: {
    pending?: AskPending | null;
    pendings?: (AskPending | null)[];
    existing?: string | null;
    write?: (sessionPath: string, id: string, answer: AskAnswer) => Promise<void>;
  } = {},
) {
  const sequence = [...(options.pendings ?? [])];
  let reads = 0;
  const writes: { path: string; id: string; answer: AskAnswer }[] = [];
  const answerer = createAskAnswerer({
    readPending: async () => {
      reads += 1;
      const next = sequence.shift();
      if (next !== undefined) return next;
      return options.pending === undefined ? OPTIONS : options.pending;
    },
    readAnswerId: async () => options.existing ?? null,
    writeAnswer: async (path, id, answer) => {
      writes.push({ path, id, answer });
      await options.write?.(path, id, answer);
    },
  });
  return {
    answerer,
    writes,
    reads: () => reads,
    answer: (payload: AnswerRequest, blocked = true) =>
      answerer.answer({
        paneId: "w1:p1",
        sessionPath: "/tmp/session.jsonl",
        blocked,
        request: payload,
      }),
  };
}

test("an option answer is written as the label from the pending ask", async () => {
  const h = harness();
  expect(await h.answer(option())).toEqual({ ok: true });
  expect(h.writes).toEqual([
    { path: "/tmp/session.jsonl", id: ID, answer: { kind: "option", label: "青" } },
  ]);
});

test("a free-text answer keeps inner newlines and tabs but trims the ends", async () => {
  const h = harness({ pending: FREE });
  const payload = request([{ question: FREE.question, text: "  1 行目\n\t2 行目  " }]);
  expect(await h.answer(payload)).toEqual({ ok: true });
  expect(h.writes[0]?.answer).toEqual({ kind: "text", text: "1 行目\n\t2 行目" });
});

test("a pane that is not blocked is not waiting", async () => {
  const h = harness();
  expect(await h.answer(option(), false)).toEqual({ ok: false, status: 409, error: "not_waiting" });
  expect(h.writes).toEqual([]);
});

test("a question that no longer exists or has another id is not waiting", async () => {
  expect(await harness({ pending: null }).answer(option())).toEqual({
    ok: false,
    status: 409,
    error: "not_waiting",
  });
  const otherId = request([{ question: OPTIONS.question, labels: ["青"] }], OTHER);
  expect(await harness().answer(otherId)).toEqual({
    ok: false,
    status: 409,
    error: "not_waiting",
  });
});

test.each([
  ["without answers", request([])],
  [
    "with two answers",
    request([
      { question: OPTIONS.question, labels: ["青"] },
      { question: OPTIONS.question, labels: ["赤"] },
    ]),
  ],
  ["with a different question", request([{ question: "別の質問", labels: ["青"] }])],
  ["without any label", request([{ question: OPTIONS.question, labels: [] }])],
  ["with two labels", request([{ question: OPTIONS.question, labels: ["赤", "青"] }])],
  ["with an unknown label", request([{ question: OPTIONS.question, labels: ["緑"] }])],
  ["with text on an options question", request([{ question: OPTIONS.question, text: "青" }])],
])("an answer %s is a bad request", async (_name, payload) => {
  const h = harness();
  expect(await h.answer(payload)).toEqual({ ok: false, status: 400, error: "invalid_answer" });
  expect(h.writes).toEqual([]);
});

test("labels are refused for a free-text question", async () => {
  const h = harness({ pending: FREE });
  const payload = request([{ question: FREE.question, labels: ["青"] }]);
  expect(await h.answer(payload)).toEqual({ ok: false, status: 400, error: "invalid_answer" });
  expect(h.writes).toEqual([]);
});

test("a text longer than the contract is a bad request", async () => {
  const h = harness({ pending: FREE });
  const payload = request([{ question: FREE.question, text: "あ".repeat(2_001) }]);
  expect(await h.answer(payload)).toEqual({ ok: false, status: 400, error: "invalid_answer" });
  expect(h.writes).toEqual([]);
});

test("an answer already written for this question is not written again", async () => {
  const h = harness({ existing: ID });
  expect(await h.answer(option())).toEqual({
    ok: false,
    status: 409,
    error: "already_answered",
  });
  expect(h.reads()).toBe(1);
  expect(h.writes).toEqual([]);
});

test("an answer left by another question is replaced", async () => {
  const h = harness({ existing: OTHER });
  expect(await h.answer(option())).toEqual({ ok: true });
  expect(h.writes).toHaveLength(1);
});

test("a pending ask that disappears before the write is not answered", async () => {
  const h = harness({ pendings: [OPTIONS, null] });
  expect(await h.answer(option())).toEqual({
    ok: false,
    status: 409,
    error: "question_changed",
  });
  expect(h.writes).toEqual([]);
});

test("a pending ask that is replaced before the write is not answered", async () => {
  const h = harness({ pendings: [OPTIONS, { ...OPTIONS, id: OTHER }] });
  expect(await h.answer(option())).toEqual({
    ok: false,
    status: 409,
    error: "question_changed",
  });
  expect(h.writes).toEqual([]);
});

test("a write failure is a 502 and is not reported as answered", async () => {
  const h = harness({
    write: async () => {
      throw new Error("read-only");
    },
  });
  expect(await h.answer(option())).toEqual({ ok: false, status: 502, error: "write_failed" });
});

test("a second request while the first is writing is refused", async () => {
  let release: () => void = () => {};
  let markStarted: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const h = harness({
    write: () => {
      markStarted();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });

  const first = h.answer(option());
  await writing;
  expect(await h.answer(option())).toEqual({ ok: false, status: 409, error: "in_progress" });
  release();
  expect(await first).toEqual({ ok: true });
  expect(h.writes).toHaveLength(1);
});

test("the pane lock is released after a failure", async () => {
  const h = harness({
    write: async () => {
      throw new Error("read-only");
    },
  });
  expect((await h.answer(option())).ok).toBe(false);
  // ロックが残っていれば in_progress になる。
  expect(await h.answer(option())).toEqual({ ok: false, status: 502, error: "write_failed" });
});
