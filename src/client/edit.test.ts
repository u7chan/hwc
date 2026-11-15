import { expect, test } from "bun:test";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { REWIND_ID_PATTERN } from "../shared/rewind";
import type { ChatRow } from "./chat";
import { canEditMessage, editFailureNotice, newRequestId } from "./edit";

const snapshot = (canRewind: boolean): ChatSnapshot => ({
  etag: "e",
  messages: [],
  model: null,
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
  canRewind,
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

test("only an older pi user message with no attachments is editable", () => {
  const rows = [row(user("u1")), row(agent("a1")), row(user("u2")), row(agent("a2"))];
  const base = {
    row: rows[0]!,
    rows,
    snapshot: snapshot(true),
    pane: pane(),
    sending: false,
    editing: false,
  };
  expect(canEditMessage(base)).toBe(true);
  expect(canEditMessage({ ...base, snapshot: snapshot(false) })).toBe(false);
  expect(canEditMessage({ ...base, editing: true })).toBe(false);
  expect(canEditMessage({ ...base, sending: true })).toBe(false);
  expect(canEditMessage({ ...base, pane: pane({ agent: "codex" }) })).toBe(false);
  expect(canEditMessage({ ...base, pane: pane({ agentStatus: "working" }) })).toBe(false);
  expect(
    canEditMessage({ ...base, row: row({ ...user("u3"), attachments: [{ name: "x", size: 1 }] }) }),
  ).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3", { text: " " })) })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3"), "pending") })).toBe(false);
  expect(canEditMessage({ ...base, row: row(user("u3"), "command") })).toBe(false);
  expect(canEditMessage({ ...base, row: row(agent("a3")) })).toBe(false);
});

test("the last session row is not editable, even when a pending echo follows", () => {
  const rows = [row(user("u1")), row(agent("a1")), row(user("u2")), row(agent("a2"))];
  const base = {
    rows,
    snapshot: snapshot(true),
    pane: pane(),
    sending: false,
    editing: false,
  };
  const lastUser = row(user("u3"));
  const withPending = [...rows, lastUser, row(user("pending-1"), "pending")];
  expect(canEditMessage({ ...base, row: lastUser, rows: withPending })).toBe(false);
  expect(canEditMessage({ ...base, row: rows[0]!, rows: withPending })).toBe(true);
});

test("editFailureNotice distinguishes a completed rewind", () => {
  expect(editFailureNotice("send_failed", true)).toContain("会話は戻りました");
  expect(editFailureNotice("not_editable", false)).toBe("この発言は編集できません");
  expect(editFailureNotice("edit_failed", false)).toContain("もう一度");
});
