import { expect, test } from "bun:test";
import type { AgentStatus, PaneState } from "../server/herdr/state";
import { composerDisabled, enterInsertsNewline } from "./input";

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

test("a blocked Claude pane closes the composer", () => {
  // 質問・権限確認の待ち。この間の Enter は TUI のダイアログへ流れる。
  expect(composerDisabled(pane("claude", "blocked"), false)).toBe(true);
});

test("other agents keep the composer while they are blocked", () => {
  // Codex と Pi の信頼確認は専用ビューが回答する。OpenCode は blocked を使わない。
  for (const agent of ["pi", "codex", "opencode", null]) {
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
