import { expect, test } from "bun:test";
import type { AgentStatus, PaneState } from "../server/herdr/state";
import { AGENT_COMMANDS, commandCandidates, commandLabel, commandText } from "./commands";

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

test("both commands are sent as the string the CLIs read", () => {
  expect(AGENT_COMMANDS.new.text).toBe("/new");
  expect(AGENT_COMMANDS.compact.text).toBe("/compact");
  expect(commandText("new")).toBe("/new");
  expect(commandText("compact")).toBe("/compact");
});

test("the label says what the command does, not how it is typed", () => {
  expect(commandLabel("new")).toBe("新しいセッション");
  expect(commandLabel("compact")).toBe("コンパクト");
});

test("a slash without whitespace narrows the candidates", () => {
  expect(commandCandidates(pane("pi"), "/")).toEqual(["new", "compact"]);
  expect(commandCandidates(pane("pi"), "/n")).toEqual(["new"]);
  // iOS は入力の先頭を大文字にする。それでも候補を出す。
  expect(commandCandidates(pane("pi"), "/N")).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/new")).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/c")).toEqual(["compact"]);
  expect(commandCandidates(pane("pi"), "/COMPACT")).toEqual(["compact"]);
});

test("text, arguments and near misses are not candidates", () => {
  expect(commandCandidates(pane("pi"), "")).toEqual([]);
  // 引数を取る形は同じ経路では送れない。本文として扱う。
  expect(commandCandidates(pane("pi"), "/compact 指示")).toEqual([]);
  expect(commandCandidates(pane("pi"), "/newx")).toEqual([]);
  expect(commandCandidates(pane("pi"), "/nee")).toEqual([]);
  expect(commandCandidates(pane("pi"), "こんにちは /new")).toEqual([]);
  expect(commandCandidates(pane("pi"), " /new")).toEqual([]);
});

test("only the four CLIs that know the commands offer them", () => {
  for (const agent of ["pi", "claude", "codex", "opencode", "Claude Code"]) {
    expect(commandCandidates(pane(agent), "/")).toHaveLength(2);
  }
  // シェルと未知のエージェントは TUI のコマンドを持たない。
  for (const agent of [null, "vim", "bash"]) {
    expect(commandCandidates(pane(agent), "/")).toEqual([]);
  }
});

test("a working pane offers no candidate, a blocked one does", () => {
  expect(commandCandidates(pane("claude", "working"), "/")).toEqual([]);
  expect(commandCandidates(pane("claude", "blocked"), "/n")).toEqual(["new"]);
  expect(commandCandidates(pane("claude", "done"), "/n")).toEqual(["new"]);
});
