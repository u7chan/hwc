import { expect, test } from "bun:test";
import type { ChatContext } from "../server/chat/contract";
import type { AgentStatus, PaneState } from "../server/herdr/state";
import {
  AGENT_COMMANDS,
  chipOnInput,
  commandAvailable,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
  isCommandPane,
  isCompactCommand,
} from "./commands";

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

function context(tokens: number | null): ChatContext {
  return { tokens, window: 200000 };
}

test("both commands are sent as the string the CLIs read", () => {
  expect(AGENT_COMMANDS.new.text).toBe("/new");
  expect(AGENT_COMMANDS.compact.text).toBe("/compact");
  expect(commandText("new")).toBe("/new");
  expect(commandText("compact")).toBe("/compact");
});

test("the label says what the command does, not how it is typed", () => {
  expect(commandLabel("new")).toBe("新しいセッション");
  expect(commandLabel("compact")).toBe("会話を圧縮");
});

test("a typed compact command is recognized with or without an instruction", () => {
  expect(isCompactCommand("/compact")).toBe(true);
  expect(isCompactCommand("/compact focus on the API")).toBe(true);
  expect(isCompactCommand("/compact\n続きをまとめる")).toBe(true);
  expect(isCompactCommand("/compaction")).toBe(false);
  expect(isCompactCommand("/compactfoo")).toBe(false);
  expect(isCompactCommand(" /compact")).toBe(false);
  expect(isCompactCommand("/new")).toBe(false);
});

test("commands are available only on the CLIs that accept them", () => {
  for (const agent of ["pi", "claude", "codex", "opencode"]) {
    const state = pane(agent);
    expect(isCommandPane(state)).toBe(true);
    expect(commandAvailable("new", state, context(50000))).toBe(true);
    expect(commandAvailable("compact", state, context(50000))).toBe(true);
  }
  expect(isCommandPane(pane(null))).toBe(false);
  expect(commandAvailable("new", pane(null), context(50000))).toBe(false);
});

test("a working agent cannot run a command", () => {
  expect(commandAvailable("new", pane("pi", "working"), context(50000))).toBe(false);
  expect(commandAvailable("compact", pane("pi", "working"), context(50000))).toBe(false);
});

test("compact is unavailable while the history is too small to compact", () => {
  expect(commandAvailable("compact", pane("pi"), context(19999))).toBe(false);
  expect(commandAvailable("compact", pane("pi"), context(20000))).toBe(true);
  // tokens が無いときは判定できないので押せる側に倒す。
  expect(commandAvailable("compact", pane("pi"), context(null))).toBe(true);
  expect(commandAvailable("compact", pane("pi"), null)).toBe(true);
  // new は履歴の大きさに依存しない。
  expect(commandAvailable("new", pane("pi"), context(0))).toBe(true);
});

test("a slash without whitespace narrows the candidates", () => {
  expect(commandCandidates(pane("pi"), "/", context(50000))).toEqual(["new", "compact"]);
  expect(commandCandidates(pane("pi"), "/n", context(50000))).toEqual(["new"]);
  // iOS は入力の先頭を大文字にする。それでも候補を出す。
  expect(commandCandidates(pane("pi"), "/N", context(50000))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/new", context(50000))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/c", context(50000))).toEqual(["compact"]);
  expect(commandCandidates(pane("pi"), "/COMPACT", context(50000))).toEqual(["compact"]);
});

test("a small history hides compact, an unknown size keeps it", () => {
  // pi の既定（20000 トークン）未満では /compact が失敗する。
  expect(commandCandidates(pane("pi"), "/", context(19999))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/c", context(19999))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/", context(20000))).toEqual(["new", "compact"]);
  // context か tokens が無いときは判定できないので出し、押せて失敗する側に倒す。
  expect(commandCandidates(pane("pi"), "/", null)).toEqual(["new", "compact"]);
  expect(commandCandidates(pane("pi"), "/", context(null))).toEqual(["new", "compact"]);
});

test("the threshold reads the context, not the agent", () => {
  // 閾値は agent ではなく context の有無で決める。context を持つ CLI（現在は pi と
  // opencode）には pi の既定値がそのまま適用される。claude は今 context を持たないが、
  // 判定が agent に依存しないことをここで見る。
  expect(commandCandidates(pane("claude"), "/c", context(1000))).toEqual([]);
  expect(commandCandidates(pane("claude"), "/c", null)).toEqual(["compact"]);
  expect(commandCandidates(pane("opencode"), "/c", context(1000))).toEqual([]);
  expect(commandCandidates(pane("opencode"), "/c", null)).toEqual(["compact"]);
});

test("text, arguments and near misses are not candidates", () => {
  expect(commandCandidates(pane("pi"), "", context(50000))).toEqual([]);
  // 引数を取る形は同じ経路では送れない。本文として扱う。
  expect(commandCandidates(pane("pi"), "/compact 指示", context(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/newx", context(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/nee", context(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "こんにちは /new", context(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), " /new", context(50000))).toEqual([]);
});

test("only the four CLIs that know the commands offer them", () => {
  for (const agent of ["pi", "claude", "codex", "opencode", "Claude Code"]) {
    expect(commandCandidates(pane(agent), "/", null)).toHaveLength(2);
  }
  // シェルと未知のエージェントは TUI のコマンドを持たない。
  for (const agent of [null, "vim", "bash"]) {
    expect(commandCandidates(pane(agent), "/", null)).toEqual([]);
  }
});

test("a working pane offers no candidate, a blocked one does", () => {
  expect(commandCandidates(pane("claude", "working"), "/", null)).toEqual([]);
  expect(commandCandidates(pane("claude", "blocked"), "/n", null)).toEqual(["new"]);
  expect(commandCandidates(pane("claude", "done"), "/n", null)).toEqual(["new"]);
});

test("compact appends the draft as one line of instructions", () => {
  expect(commandSendText("compact", "")).toBe("/compact");
  expect(commandSendText("compact", "   ")).toBe("/compact");
  expect(commandSendText("compact", "\n\n")).toBe("/compact");
  expect(commandSendText("compact", "  a  b ")).toBe("/compact a b");
  // hwc は 1 回で送るので、途中改行は TUI の途中送信になり得る。畳んでから送る。
  expect(commandSendText("compact", "要点を\n短く")).toBe("/compact 要点を 短く");
  expect(commandSendText("compact", "a\tb")).toBe("/compact a b");
});

test("new is sent as is, whatever the draft holds", () => {
  expect(commandSendText("new", "")).toBe("/new");
});

test("typing keeps the compact chip and drops the new chip", () => {
  // compact のチップ中は入力欄が指示の入力になる。
  expect(chipOnInput("compact")).toBe("compact");
  // new のチップは文字を打つと解除し、従来のテキスト送信へ戻る。
  expect(chipOnInput("new")).toBeNull();
  expect(chipOnInput(null)).toBeNull();
});
