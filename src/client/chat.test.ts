import { expect, test } from "bun:test";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS } from "./api";
import {
  agentInfo,
  agentInfoLabel,
  chatPollDelay,
  isAbortError,
  isPendingConfirmed,
  paneBody,
  pollOnStatusChange,
} from "./chat";

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

const pending: ChatMessage = { id: "pending-1", role: "user", text: "steer", at: 1_000_000 };

test("a pending message is replaced only by a matching user message", () => {
  expect(isPendingConfirmed(pending, [{ ...pending, id: "m2", at: pending.at + 500 }])).toBe(true);
  expect(isPendingConfirmed(pending, [{ ...pending, id: "m2", at: pending.at - 30_000 }])).toBe(
    true,
  );
  expect(isPendingConfirmed(pending, [{ ...pending, id: "m2", at: pending.at - 120_000 }])).toBe(
    false,
  );
  expect(isPendingConfirmed(pending, [{ ...pending, id: "m2", role: "agent" }])).toBe(false);
  expect(isPendingConfirmed(pending, [{ ...pending, id: "m2", text: "other" }])).toBe(false);
});
