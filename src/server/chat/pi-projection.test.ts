import { expect, test } from "bun:test";
import type { ChatMessage, ChatUsage } from "./contract";
import type { SessionAskQuestion, SessionAskResult, SessionEntry } from "./pi-entry";
import { foldMessages, latestValues, pairAsks } from "./pi-projection";

const entry = (fields: Partial<SessionEntry> & { id: string }): SessionEntry => ({
  parentId: null,
  messages: [],
  askQuestions: [],
  askResults: [],
  model: null,
  provider: null,
  effort: null,
  usageTokens: null,
  usage: null,
  invalidatesUsage: false,
  compactionEntry: false,
  compaction: null,
  ...fields,
});

const message = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({
  id,
  role,
  text,
  at: 0,
});

const question = (toolCallId = "call_ask"): SessionAskQuestion => ({
  toolCallId,
  question: "どれにしますか？",
  options: ["赤", "青"],
  recommended: "赤",
  at: 1,
});

const result = (
  toolCallId = "call_ask",
  fields: Partial<SessionAskResult> = {},
): SessionAskResult => ({
  toolCallId,
  status: "answered",
  askId: "ask-1",
  kind: "option",
  answer: "青",
  at: 2,
  ...fields,
});

const usage = (input: number): ChatUsage => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
});

test("pairs a result only with the call that precedes it", () => {
  // 中断した呼び出しの result が遅れて書かれても、後から同じ toolCallId で始まった
  // 呼び出しの回答にしない。
  const early = result("call_same", { askId: "ask-early" });
  const call = question("call_same");
  const pairing = pairAsks([
    entry({ id: "r0", askResults: [early] }),
    entry({ id: "a1", messages: [message("a1", "agent", "確認します。")], askQuestions: [call] }),
    entry({ id: "r1", askResults: [result("call_same", { askId: "ask-late" })] }),
  ]);

  expect(pairing.resultKeys.has(early)).toBe(false);
  expect(pairing.questionKeys.get(call)).toBe("a1:call_same:0");
  expect(pairing.askIds.get("a1:call_same:0")).toBe("ask-late");
  expect([...pairing.answered]).toEqual(["a1:call_same:0"]);
});

test("an answered result without an answer does not complete the question", () => {
  // 空の回答は本文が無い。回答済みとして履歴に合成せず、pending カードに残す。
  const pairing = pairAsks([
    entry({ id: "a1", askQuestions: [question()] }),
    entry({ id: "r1", askResults: [result("call_ask", { answer: null })] }),
  ]);

  expect(pairing.resultKeys.size).toBe(1);
  expect(pairing.results.get("a1:call_ask:0")?.answer).toBeNull();
  expect(pairing.answered.size).toBe(0);
});

test("a compaction hides the ask pair before its kept entry", () => {
  const call = question();
  const answer = result();
  const branch = [
    entry({ id: "a1", messages: [message("a1", "agent", "確認します。")], askQuestions: [call] }),
    entry({ id: "r1", askResults: [answer] }),
    entry({ id: "u2", messages: [message("u2", "user", "続けて")] }),
    entry({
      id: "c1",
      compactionEntry: true,
      compaction: { summary: "so far", firstKeptEntryId: "u2", tokensBefore: 10, at: 3 },
    }),
  ];

  const history = foldMessages(branch, pairAsks(branch));

  expect(history.messages.map((item) => item.id)).toEqual(["u2"]);
  expect(history.beforeCompaction).toBe(1);
  expect(history.compaction).toEqual({ at: 3, tokensBefore: 10, summary: "so far" });
});

test("a kept ask pair counts toward the rule position", () => {
  // 合成した Q&A も会話の行なので、区切りの件数に含める。
  const branch = [
    entry({ id: "a1", askQuestions: [question()] }),
    entry({ id: "r1", askResults: [result()] }),
    entry({ id: "u2", messages: [message("u2", "user", "続けて")] }),
    entry({
      id: "c1",
      compactionEntry: true,
      compaction: { summary: "so far", firstKeptEntryId: "a1", tokensBefore: 10, at: 3 },
    }),
  ];

  const history = foldMessages(branch, pairAsks(branch));

  expect(history.messages.map((item) => item.id)).toEqual([
    "ask:a1:call_ask:0:question",
    "ask:a1:call_ask:0:answer",
    "u2",
  ]);
  expect(history.beforeCompaction).toBe(3);
});

test("has no latest values for an empty branch", () => {
  expect(latestValues([])).toEqual({
    model: null,
    provider: null,
    effort: null,
    tokens: null,
    usage: null,
  });
});

test("takes each latest value from its own last entry", () => {
  // 値を持たない entry を挟んでも、それぞれ最後に現れた値が残る。
  const latest = latestValues([
    entry({ id: "a1", model: "model-a", provider: "p", effort: "high" }),
    entry({ id: "m1", model: "model-b", provider: "p", usageTokens: 100, usage: usage(100) }),
    entry({ id: "t1", effort: "low" }),
    entry({ id: "u1", messages: [message("u1", "user", "next")] }),
  ]);

  expect(latest).toEqual({
    model: "model-b",
    provider: "p",
    effort: "low",
    tokens: 100,
    usage: usage(100),
  });
});

test("an invalidation after the last usage clears it", () => {
  // 圧縮より後の回答が無い間は、いまのコンテキスト量が分からない。model と effort は
  // 変わらず最新の値を使う。
  const latest = latestValues([
    entry({ id: "a1", model: "model-a", provider: "p", usageTokens: 100, usage: usage(100) }),
    entry({ id: "m1", model: "model-b", provider: "p" }),
    entry({ id: "e1", effort: "low" }),
    entry({ id: "c1", invalidatesUsage: true }),
  ]);

  expect(latest).toEqual({
    model: "model-b",
    provider: "p",
    effort: "low",
    tokens: null,
    usage: null,
  });
});
