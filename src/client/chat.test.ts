import { expect, test } from "bun:test";
import type { ChatContext, ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PendingMessage } from "./chat";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS } from "./api";
import {
  agentInfo,
  agentInfoLabel,
  chatPollDelay,
  compactionLabel,
  contextFill,
  contextMeter,
  contextPercent,
  contextText,
  contextTone,
  formatTokens,
  isAbortError,
  isPendingConfirmed,
  latestUserAt,
  paneBody,
  pollOnStatusChange,
} from "./chat";

const snapshot: ChatSnapshot = {
  etag: "abc",
  messages: [{ id: "m1", role: "user", text: "hello", at: 1_000 }],
  model: "pi-large",
  effort: "high",
  truncated: false,
  context: null,
  compaction: null,
};

const empty: ChatSnapshot = { ...snapshot, messages: [] };

test("a working pane is read more often than an idle one", () => {
  expect(chatPollDelay("working", "visible")).toBe(CHAT_POLL_ACTIVE_MS);
  expect(chatPollDelay("idle", "visible")).toBe(CHAT_POLL_IDLE_MS);
  // 要対応でも読む頻度は待機と同じ。返答は止まっている。
  expect(chatPollDelay("blocked", "visible")).toBe(CHAT_POLL_IDLE_MS);
});

test("a hidden page stops reading the conversation", () => {
  expect(chatPollDelay("working", "hidden")).toBeNull();
  expect(chatPollDelay("idle", "hidden")).toBeNull();
});

test("a turn that starts while the pane waits is read without waiting", () => {
  // idle の 5 秒待機中に working へ変わる。予約を待たずに読む。
  expect(pollOnStatusChange({ last: "idle", next: "working", visible: true })).toBe("load");
  expect(pollOnStatusChange({ last: "blocked", next: "working", visible: true })).toBe("load");
});

test("the end of a turn is read without waiting", () => {
  expect(pollOnStatusChange({ last: "working", next: "done", visible: true })).toBe("load");
  expect(pollOnStatusChange({ last: "working", next: "idle", visible: true })).toBe("load");
});

test("the first load is not asked for twice", () => {
  // マウント直後とペイン切替直後は、最初の取得と同じ状態でここへ来る。
  expect(pollOnStatusChange({ last: "working", next: "working", visible: true })).toBe("ignore");
  expect(pollOnStatusChange({ last: "idle", next: "idle", visible: true })).toBe("ignore");
});

test("a status change does not read while the page is hidden", () => {
  expect(pollOnStatusChange({ last: "idle", next: "working", visible: false })).toBe("ignore");
});

test("a cancellation is not a failure", () => {
  expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  expect(isAbortError(new Error("network"))).toBe(false);
  expect(isAbortError(null)).toBe(false);
  expect(isAbortError("AbortError")).toBe(false);
});

test("the terminal output is shown until the conversation is readable", () => {
  // 会話を持たないペインは端末出力のまま。
  expect(paneBody({ chat: false, blocked: false, failed: false, snapshot })).toEqual({
    kind: "output",
  });
  // 要対応の間は端末を見たい。
  expect(paneBody({ chat: true, blocked: true, failed: false, snapshot })).toEqual({
    kind: "output",
  });
  // 読めない間も端末出力へ切り替える。
  expect(paneBody({ chat: true, blocked: false, failed: true, snapshot: null })).toEqual({
    kind: "output",
  });
});

test("the conversation replaces the skeleton once a snapshot arrives", () => {
  expect(paneBody({ chat: true, blocked: false, failed: false, snapshot: null })).toEqual({
    kind: "skeleton",
  });
  expect(paneBody({ chat: true, blocked: false, failed: false, snapshot })).toEqual({
    kind: "chat",
    snapshot,
  });
});

test("an empty conversation is still a conversation", () => {
  expect(paneBody({ chat: true, blocked: false, failed: false, snapshot: empty })).toEqual({
    kind: "chat",
    snapshot: empty,
  });
});

test("model and effort are shown only when the session has them", () => {
  expect(agentInfo(null)).toBeNull();
  expect(agentInfo({ ...snapshot, model: null, effort: null })).toBeNull();
  expect(agentInfo(snapshot)).toEqual({ model: "pi-large", effort: "high" });
  expect(agentInfo({ ...snapshot, model: "pi-large", effort: null })).toEqual({
    model: "pi-large",
    effort: null,
  });
  expect(agentInfo({ ...snapshot, model: null, effort: "low" })).toEqual({
    model: null,
    effort: "low",
  });
});

test("the label shows the parts that exist", () => {
  expect(agentInfoLabel({ model: "pi-large", effort: "high" })).toBe("pi-large · effort high");
  expect(agentInfoLabel({ model: "pi-large", effort: null })).toBe("pi-large");
  expect(agentInfoLabel({ model: null, effort: "low" })).toBe("effort low");
});

test("token counts are shortened the way pi's footer does", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1_000)).toBe("1.0k");
  expect(formatTokens(9_999)).toBe("10.0k");
  expect(formatTokens(122_600)).toBe("123k");
  expect(formatTokens(999_999)).toBe("1000k");
  expect(formatTokens(1_000_000)).toBe("1.0M");
  expect(formatTokens(1_050_000)).toBe("1.1M");
  expect(formatTokens(12_345_678)).toBe("12M");
});

test("the percent is derived from tokens and window, one decimal below 10%", () => {
  expect(contextPercent({ tokens: 122_600, window: 1_000_000 })).toBeCloseTo(12.26);
  expect(contextPercent({ tokens: null, window: 1_000_000 })).toBeNull();
  expect(contextPercent({ tokens: 122_600, window: null })).toBeNull();
  // window 0 は Infinity になる。BFF はこの形を送らないが、描画側でも作らない。
  expect(contextPercent({ tokens: 122_600, window: 0 })).toBeNull();
});

test("the meter turns to attention only above 70%", () => {
  expect(contextTone(0)).toBe("secondary");
  expect(contextTone(70)).toBe("secondary");
  expect(contextTone(70.1)).toBe("attention");
  expect(contextTone(140)).toBe("attention");
});

test("the fill stays inside the track while the number may pass 100%", () => {
  expect(contextFill(12.3)).toBe(12.3);
  expect(contextFill(-5)).toBe(0);
  expect(contextFill(140)).toBe(100);
});

// Issue #45 の表と同じ並び。材料が増える順に、広い表現と狭い表現を固定する。
const contextRows: Array<{ context: ChatContext; wide: string | null; narrow: string | null }> = [
  {
    context: { tokens: 122_600, window: 1_000_000 },
    wide: "123k/1.0M (12.3%)",
    narrow: "12.3%",
  },
  { context: { tokens: null, window: 1_000_000 }, wide: "?/1.0M", narrow: "?" },
  { context: { tokens: 122_600, window: null }, wide: "123k/?", narrow: "123k" },
  { context: { tokens: null, window: null }, wide: null, narrow: null },
];

test("the context text falls back to the material it has in each width", () => {
  for (const row of contextRows) {
    expect(contextText(row.context, false)).toBe(row.wide);
    expect(contextText(row.context, true)).toBe(row.narrow);
  }
});

test("the meter is drawn only when there is something to show", () => {
  expect(contextMeter(null)).toBeNull();
  expect(contextMeter({ tokens: null, window: null })).toBeNull();
  expect(contextMeter({ tokens: 900_000, window: 1_000_000 })).toEqual({
    wide: "900k/1.0M (90.0%)",
    narrow: "90.0%",
    percent: 90,
    fill: 90,
    tone: "attention",
  });
  // window が分からないときは percent もバーも無い。
  expect(contextMeter({ tokens: 122_600, window: null })).toEqual({
    wide: "123k/?",
    narrow: "123k",
    percent: null,
    fill: 0,
    tone: "secondary",
  });
});

test("the compaction line says how much was compressed", () => {
  expect(compactionLabel({ at: 1_000, tokensBefore: 212_959, summary: "so far" })).toBe(
    "212,959 tokens から圧縮",
  );
  expect(compactionLabel({ at: 1_000, tokensBefore: 950, summary: "so far" })).toBe(
    "950 tokens から圧縮",
  );
  // 数を出せないときは、圧縮だけを伝える。
  expect(compactionLabel({ at: 1_000, tokensBefore: null, summary: "so far" })).toBe("圧縮");
});

const pending: PendingMessage = {
  id: "pending-1",
  role: "user",
  text: "  steer  ",
  at: 1_000_000,
  from: 990_000,
  waiting: true,
};

test("the latest user message sets the pending baseline", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "old", at: 100 },
    { id: "a1", role: "agent", text: "reply", at: 200 },
    { id: "u2", role: "user", text: "last", at: 300 },
  ];
  expect(latestUserAt(messages)).toBe(300);
  expect(latestUserAt([])).toBe(0);
  expect(latestUserAt(messages.filter((message) => message.role === "agent"))).toBe(0);
});

test("a pending message is confirmed by a new user message after its baseline", () => {
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "user", text: "steer", at: pending.from + 1 }]),
  ).toBe(true);
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "user", text: "steer", at: pending.from }]),
  ).toBe(false);
  expect(
    isPendingConfirmed(pending, [{ id: "m2", role: "agent", text: "steer", at: pending.from + 1 }]),
  ).toBe(false);
  expect(isPendingConfirmed(pending, [])).toBe(false);
});
