import { expect, test } from "bun:test";
import type { PaneState } from "../server/herdr/state";
import {
  launchFailureMessage,
  launchPhase,
  STARTING_LIMIT_MS,
  STARTING_SETTLE_MS,
  type PaneLaunch,
} from "./starting";

const AT = 1_000;

const pane = (overrides: Partial<PaneState> = {}): PaneState => ({
  id: "w1:p2",
  title: null,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: false,
  chat: false,
  ...overrides,
});

const launch = (overrides: Partial<PaneLaunch> = {}): PaneLaunch => ({
  paneId: "w1:p2",
  at: AT,
  agent: "pi",
  model: null,
  effort: null,
  request: "started",
  waitForShell: true,
  error: null,
  ...overrides,
});

test("a pending launch stays closed before the pane appears in the snapshot", () => {
  expect(launchPhase(launch({ request: "waiting" }), pane({ agent: null }), AT)).toBe("launching");
  expect(launchPhase(launch({ request: "waiting" }), pane({ chat: true }), AT)).toBe("launching");
});

test("a started launch opens after the settle window once the conversation is readable", () => {
  const readable = pane({ chat: true });
  expect(launchPhase(launch(), readable, AT)).toBe("launching");
  expect(launchPhase(launch(), readable, AT + STARTING_SETTLE_MS)).toBe("ready");
});

test("a chat agent stays closed while its conversation is not readable yet", () => {
  for (const agent of ["pi", "codex", "opencode"] as const) {
    const detected = pane({ agent });
    expect(launchPhase(launch(), detected, AT + STARTING_SETTLE_MS)).toBe("launching");
    expect(launchPhase(launch(), detected, AT + STARTING_LIMIT_MS - 1)).toBe("launching");
    expect(launchPhase(launch(), detected, AT + STARTING_LIMIT_MS)).toBe("unknown");
    expect(launchPhase(launch(), pane({ agent, chat: true }), AT + STARTING_SETTLE_MS)).toBe(
      "ready",
    );
  }
});

test("an agent without chat opens as soon as it owns the terminal", () => {
  expect(launchPhase(launch({ agent: "claude" }), pane({ agent: "claude" }), AT)).toBe("launching");
  expect(
    launchPhase(launch({ agent: "claude" }), pane({ agent: "claude" }), AT + STARTING_SETTLE_MS),
  ).toBe("ready");
});

test("a pane without a detected agent stays closed until the agent arrives", () => {
  const shell = pane({ agent: null });
  expect(launchPhase(launch(), shell, AT + STARTING_SETTLE_MS)).toBe("launching");
  expect(launchPhase(launch(), shell, AT + STARTING_LIMIT_MS - 1)).toBe("launching");
  expect(launchPhase(launch(), shell, AT + STARTING_LIMIT_MS)).toBe("unknown");
});

test("a failed launch opens for a shell and keeps waiting when an agent is detected", () => {
  const failed = launch({ request: "failed", error: "agent_start_failed" });
  expect(launchPhase(failed, pane({ agent: null }), AT)).toBe("failed");
  // 要求は失敗したが、エージェントは検出されている。会話が読めるまでは起動待ちのまま。
  expect(launchPhase(failed, pane({ chat: false }), AT)).toBe("launching");
  expect(launchPhase(failed, pane({ chat: false }), AT + STARTING_LIMIT_MS)).toBe("unknown");
  expect(launchPhase(failed, pane({ chat: true }), AT)).toBe("ready");
});

test("the snapshot wins over a failed or timed out request", () => {
  const failed = launch({ request: "failed", error: "timeout" });
  expect(launchPhase(failed, pane({ agent: "claude" }), AT)).toBe("ready");
});

test("the record only applies to the pane it was created for", () => {
  expect(launchPhase(launch(), pane({ id: "w1:p3" }), AT)).toBeNull();
  expect(launchPhase(null, pane(), AT)).toBeNull();
});

test("the failure message names the reason", () => {
  expect(launchFailureMessage("pane_busy")).toContain("コマンドが動いています");
  expect(launchFailureMessage("agent_start_failed")).toContain("シェルのまま残っています");
  expect(launchFailureMessage(null)).toContain("もう一度お試しください");
});
