import { expect, test } from "bun:test";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";
import {
  REVEAL_MAX_CHARS,
  REVEAL_MAX_MS,
  REVEAL_MIN_CHARS,
  REVEAL_MIN_MS,
  revealDurationMs,
  revealPlan,
  revealTarget,
  revealedLength,
} from "./reveal";

const base: ChatSnapshot = {
  etag: "abc",
  messages: [{ id: "u1", role: "user", text: "hello", at: 1_000 }],
  model: "pi-large",
  effort: "high",
  truncated: false,
  context: null,
  compaction: null,
};

const agent: ChatMessage = { id: "a1", role: "agent", text: "reply", at: 1_100 };

test("a reply appended to the loaded conversation is revealed", () => {
  const next = { ...base, messages: [...base.messages, agent] };
  expect(revealTarget(base, next)).toEqual(agent);
});

test("the same conversation is not an append", () => {
  // 取得のたびに新しいスナップショットになるが、増えていなければ何もしない。
  const same = { ...base, messages: [...base.messages] };
  expect(revealTarget(base, same)).toBeNull();
});

test("an empty conversation that receives a reply is an append", () => {
  // /new の直後や、空の会話を開いたまま待っているとき。最初の 1 通は再生する。
  const loaded = { ...base, messages: [agent] };
  expect(revealTarget({ ...base, messages: [] }, loaded)).toEqual(agent);
});

test("a user echo or an error row does not start a reveal", () => {
  const withUser = {
    ...base,
    messages: [...base.messages, { id: "u2", role: "user" as const, text: "next", at: 2_000 }],
  };
  expect(revealTarget(base, withUser)).toBeNull();
  const withError = {
    ...base,
    messages: [...base.messages, { id: "e1", role: "error" as const, text: "failed", at: 2_000 }],
  };
  expect(revealTarget(base, withError)).toBeNull();
});

test("a replaced conversation is not treated as an append", () => {
  // ペイン切替・/new・圧縮で窓が動いたとき。前回の末尾が残っていない。
  const replaced = {
    ...base,
    messages: [{ id: "u9", role: "user" as const, text: "new", at: 3_000 }, agent],
  };
  expect(revealTarget(base, replaced)).toBeNull();
});

test("only the newest added message can start a reveal", () => {
  // 差分が複数あるときは末尾だけ。途中の agent メッセージを再生しない。
  const older: ChatMessage = { id: "a0", role: "agent", text: "older", at: 1_050 };
  const next = { ...base, messages: [...base.messages, older, agent] };
  expect(revealTarget(base, next)).toEqual(agent);
});

test("the duration is clamped to a short animation", () => {
  expect(revealDurationMs(200)).toBe(REVEAL_MIN_MS);
  expect(revealDurationMs(500)).toBe(3_000);
  expect(revealDurationMs(1_000)).toBe(REVEAL_MAX_MS);
  expect(revealDurationMs(REVEAL_MAX_CHARS)).toBe(REVEAL_MAX_MS);
});

test("short, huge, and reduced-motion replies are shown at once", () => {
  const text = "a".repeat(REVEAL_MIN_CHARS - 1);
  expect(revealPlan({ ...agent, text }, false)).toBeNull();
  expect(revealPlan({ ...agent, text: "a".repeat(REVEAL_MAX_CHARS + 1) }, false)).toBeNull();
  expect(revealPlan({ ...agent, text: "a".repeat(REVEAL_MIN_CHARS) }, true)).toBeNull();
});

test("a reply is split by code point so emoji is never cut in half", () => {
  const text = `🙂${"あ".repeat(REVEAL_MIN_CHARS)}`;
  const plan = revealPlan({ ...agent, text }, false);
  expect(plan).not.toBeNull();
  expect(plan?.chars.length).toBe(Array.from(text).length);
  expect(plan?.chars[0]).toBe("🙂");
  expect(plan?.chars.join("")).toBe(text);
});

test("the elapsed time decides how much is shown", () => {
  expect(revealedLength(0, 0, 2_000)).toBe(0);
  expect(revealedLength(1_000, 0, 2_000)).toBe(1);
  expect(revealedLength(1_000, 1_000, 2_000)).toBe(500);
  expect(revealedLength(1_000, 2_000, 2_000)).toBe(1_000);
  // 隠れたタブから戻ったときは、経過ぶんまで進めて追いつく。
  expect(revealedLength(1_000, 90_000, 2_000)).toBe(1_000);
  expect(revealedLength(1_000, 10, 0)).toBe(1_000);
});
