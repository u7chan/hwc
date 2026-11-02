import { expect, test } from "bun:test";
import type { ChatSnapshot } from "../server/chat/contract";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS } from "./api";
import { agentInfo, agentInfoLabel, chatPollDelay, isAbortError, paneBody } from "./chat";

const snapshot: ChatSnapshot = {
  etag: "abc",
  messages: [{ id: "m1", role: "user", text: "hello", at: 1_000 }],
  model: "pi-large",
  effort: "high",
  truncated: false,
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
