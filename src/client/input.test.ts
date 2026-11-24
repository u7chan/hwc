import { expect, test } from "bun:test";
import type { AgentStatus, PaneState } from "../server/herdr/state";
import {
  composerDisabled,
  enterInsertsNewline,
  enterSubmits,
  projectMentionAllowed,
} from "./input";

function enter(overrides: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
  return { shiftKey: false, isComposing: false, keyCode: 13, ...overrides };
}

function pane(agent: string | null, agentStatus: AgentStatus = "idle"): PaneState {
  return {
    id: "w1:p1",
    title: null,
    label: null,
    agent,
    agentStatus,
    focused: true,
    chat: agent !== null,
  };
}

test("a touch device inserts a newline on Enter instead of sending", () => {
  const coarse = (query: string) => query === "(pointer: coarse)";
  expect(enterInsertsNewline(coarse)).toBe(true);

  // マウスのある端末は従来どおり Enter で送る。
  const fine = () => false;
  expect(enterInsertsNewline(fine)).toBe(false);
});

test("Enter sends on a fine pointer and stays a newline elsewhere", () => {
  expect(enterSubmits(enter(), false)).toBe(true);
  expect(enterSubmits(enter(), true)).toBe(false);
});

test("Shift+Enter always inserts a newline", () => {
  expect(enterSubmits(enter({ shiftKey: true }), false)).toBe(false);
});

test("Enter that confirms an IME conversion does not send", () => {
  expect(enterSubmits(enter({ isComposing: true }), false)).toBe(false);
  expect(enterSubmits(enter({ keyCode: 229 }), false)).toBe(false);
});

test("the @ suggestions are for devices with a fine pointer only", () => {
  expect(projectMentionAllowed(() => false)).toBe(true);
  expect(projectMentionAllowed((query) => query === "(pointer: coarse)")).toBe(false);
});

test("a blocked Claude pane closes the composer", () => {
  // 質問・権限確認の待ち。この間の Enter は TUI のダイアログへ流れる。
  expect(composerDisabled(pane("claude", "blocked"), false)).toBe(true);
});

test("a blocked Pi pane closes the composer", () => {
  // ask_user の質問待ち。この間の Enter は TUI のダイアログへ流れる。
  expect(composerDisabled(pane("pi", "blocked"), false)).toBe(true);
});

test("other agents keep the composer while they are blocked", () => {
  // Codex の信頼確認は専用ビューが回答する。OpenCode は blocked を使わない。
  for (const agent of ["codex", "opencode", null]) {
    expect(composerDisabled(pane(agent, "blocked"), false)).toBe(false);
  }
});

test("the composer stays while a Claude pane is not blocked", () => {
  for (const agentStatus of ["idle", "working", "done", "unknown"] as const) {
    expect(composerDisabled(pane("claude", agentStatus), false)).toBe(false);
  }
});

test("readOnly closes the composer for every agent", () => {
  for (const agent of ["pi", "claude", "codex", "opencode", null]) {
    expect(composerDisabled(pane(agent, "idle"), true)).toBe(true);
  }
});
