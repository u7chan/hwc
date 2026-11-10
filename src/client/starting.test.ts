import { expect, test } from "bun:test";
import type { PaneState } from "../server/herdr/state";
import { paneStarting, STARTING_LIMIT_MS, STARTING_SETTLE_MS } from "./starting";

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

const starting = { paneId: "w1:p2", at: AT };

test("a created pane stays locked right after the response, before the first fresh screen", () => {
  // 応答の時点でエージェントは検出済みでも、hwc が読んでいる画面は起動前のことがある。
  expect(paneStarting(starting, pane(), AT)).toBe(true);
  expect(paneStarting(starting, pane({ agent: null }), AT)).toBe(true);
});

test("the lock opens after the settle window when the agent owns the terminal", () => {
  expect(paneStarting(starting, pane(), AT + STARTING_SETTLE_MS)).toBe(false);
});

test("a pane without a detected agent stays locked until the agent arrives", () => {
  const shell = pane({ agent: null });
  expect(paneStarting(starting, shell, AT + STARTING_SETTLE_MS)).toBe(true);
  expect(paneStarting(starting, shell, AT + STARTING_LIMIT_MS - 1)).toBe(true);
  expect(paneStarting(starting, pane(), AT + STARTING_LIMIT_MS - 1)).toBe(false);
});

test("the lock opens at the agent start deadline so the pane is never unreachable", () => {
  expect(paneStarting(starting, pane({ agent: null }), AT + STARTING_LIMIT_MS)).toBe(false);
});

test("the record only applies to the pane it was created for", () => {
  expect(paneStarting(starting, pane({ id: "w1:p3" }), AT)).toBe(false);
  expect(paneStarting(null, pane(), AT)).toBe(false);
});

test("an expired record never locks the pane again", () => {
  expect(paneStarting(starting, pane(), AT + STARTING_LIMIT_MS * 2)).toBe(false);
});
