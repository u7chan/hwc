import { expect, test } from "bun:test";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { REWIND_ID_PATTERN } from "../shared/rewind";
import type { ChatRow } from "./chat";
import { canEditMessage, editFailureNotice, newRequestId } from "./edit";

const snapshot = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  etag: "e",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
  canRewind: true,
  ...overrides,
});

const pane = (overrides: Partial<PaneState> = {}): PaneState => ({
  id: "w1:p1",
  title: null,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: true,
  chat: true,
  ...overrides,
});

const user = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "user",
  text: "hello",
  at: 1,
  ...overrides,
});

const agent = (id: string): ChatMessage => ({ id, role: "agent", text: "hi", at: 2 });

const row = (message: ChatMessage, echo: ChatRow["echo"] = "none"): ChatRow => ({
  message,
  echo,
  seen: 0,
});

test("newRequestId uses the contract alphabet and stays short", () => {
  const first = newRequestId(1, 0.123456789);
  const second = newRequestId(2, 0.987654321);
  expect(first).toMatch(REWIND_ID_PATTERN);
  expect(second).toMatch(REWIND_ID_PATTERN);
  expect(first).not.toBe(second);
  expect(first.length).toBeLessThanOrEqual(64);
});

test("only a pi user message that is not the session leaf is editable", () => {
  const base = {
    row: row(user("u1")),
    snapshot: snapshot({ leafId: "a1" }),
    pane: pane(),
    sending: false,
    editing: false,
  };
  expect(canEditMessage(base)).toBe(true);
  expect(canEditMessage({ ...base, snapshot: snapshot({ canRewind: false }) })).toBe(false);
  expect(canEditMessage({ ...base, editing: true })).toBe(false);
  expect(canEditMessage({ ...base, sending: true })).toBe(false);
  expect(canEditMessage({ ...base, pane: pane({ agent: "codex" }) })).toBe(false);
  expect(canEditMessage({ ...base, pane: pane({ agentStatus: "working" }) })).toBe(false);
  // 質問の待ちの間は、TUI のダイアログが入力を受け取る。
  expect(canEditMessage({ ...base, pane: pane({ agentStatus: "blocked" }) })).toBe(false);
  expect(
    canEditMessage({ ...base, row: row({ ...user("u3"), attachments: [{ name: "x", size: 1 }] }) }),
  ).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3", { text: " " })) })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3"), "pending") })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3"), "command") })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3", { synthetic: true })) })).toBe(false);
  expect(canEditMessage({ ...base, row: row(agent("a3")) })).toBe(false);
});

test("the session leaf is not editable", () => {
  const base = {
    snapshot: snapshot({ leafId: "u2" }),
    pane: pane(),
    sending: false,
    editing: false,
  };
  expect(canEditMessage({ ...base, row: row(user("u2")) })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u1")) })).toBe(true);
});

test("a user message is editable while the leaf is an entry the log does not show", () => {
  // 応答を止めると、本文なしの assistant が葉として残る。表示は送った発言で終わるが、
  // 戻す先はあるので編集できる。
  const base = {
    row: row(user("u2")),
    snapshot: snapshot({ leafId: "a-aborted" }),
    pane: pane(),
    sending: false,
    editing: false,
  };
  expect(canEditMessage(base)).toBe(true);
  expect(canEditMessage({ ...base, row: row(agent("a-aborted")) })).toBe(false);
});

test("editFailureNotice distinguishes a completed rewind", () => {
  expect(editFailureNotice("send_failed", true)).toContain("会話は戻りました");
  expect(editFailureNotice("not_editable", false)).toBe("この発言は編集できません");
  expect(editFailureNotice("edit_failed", false)).toContain("もう一度");
});
