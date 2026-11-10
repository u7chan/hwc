import { expect, test } from "bun:test";
import type { ChatContext, ChatSnapshot } from "../server/chat/contract";
import type { AgentStatus, PaneState } from "../server/herdr/state";
import {
  AGENT_COMMANDS,
  chipOnInput,
  commandAvailable,
  commandBlockReasonFor,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
  compactAlreadyDone,
  compactHistoryBlocked,
  conversationEmpty,
  isCommandPane,
  isCompactCommand,
  isNewSessionCommand,
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

function snapshot(
  messages: number,
  compactionIndex: number | null,
  tokens: number | null = null,
): ChatSnapshot {
  return {
    etag: "e",
    messages: Array.from({ length: messages }, (_, index) => ({
      id: `m${index}`,
      role: "user",
      text: "x",
      at: 1,
    })),
    model: null,
    effort: null,
    truncated: false,
    context: tokens === null ? null : { tokens, window: 200000 },
    compaction:
      compactionIndex === null
        ? null
        : { at: 1, tokensBefore: null, summary: "so far", index: compactionIndex },
  };
}

// 会話のあるペイン。command の可否は履歴の大きさで変わるので tokens を渡す。
function chat(tokens: number | null): ChatSnapshot {
  return snapshot(2, null, tokens);
}

test("compact is already done when the compaction is after the last message", () => {
  expect(compactAlreadyDone(snapshot(2, 2))).toBe(true);
  expect(compactAlreadyDone(snapshot(0, 0))).toBe(true);
  expect(compactAlreadyDone(snapshot(2, 1))).toBe(false);
  expect(compactAlreadyDone(snapshot(2, null))).toBe(false);
});

test("the compact history threshold is exposed for the menu note", () => {
  expect(compactHistoryBlocked(context(19999))).toBe(true);
  expect(compactHistoryBlocked(context(20000))).toBe(false);
  expect(compactHistoryBlocked(context(null))).toBe(false);
  expect(compactHistoryBlocked(null)).toBe(false);
});

test("both commands are sent as the string the CLIs read", () => {
  expect(AGENT_COMMANDS.new.text).toBe("/new");
  expect(AGENT_COMMANDS.compact.text).toBe("/compact");
  expect(commandText("new")).toBe("/new");
  expect(commandText("compact")).toBe("/compact");
});

test("the label says what the command does, not how it is typed", () => {
  expect(commandLabel("new")).toBe("新しい会話");
  expect(commandLabel("compact")).toBe("会話を圧縮");
});

test("only a bare new command starts a new conversation", () => {
  expect(isNewSessionCommand("/new")).toBe(true);
  expect(isNewSessionCommand(" /new\n")).toBe(true);
  expect(isNewSessionCommand("/NEW")).toBe(false);
  expect(isNewSessionCommand("/new topic")).toBe(false);
  expect(isNewSessionCommand("/newer")).toBe(false);
  expect(isNewSessionCommand("hello /new")).toBe(false);
  expect(isNewSessionCommand("/compact")).toBe(false);
});

test("a typed compact command is recognized the same way pi parses it", () => {
  expect(isCompactCommand("/compact")).toBe(true);
  expect(isCompactCommand(" /compact ")).toBe(true);
  expect(isCompactCommand("/compact focus on the API")).toBe(true);
  // pi は改行やタブをコマンドの区切りにしない。末尾の空白だけは trim で落ちる。
  expect(isCompactCommand("/compact\n続きをまとめる")).toBe(false);
  expect(isCompactCommand("/compact\t続きをまとめる")).toBe(false);
  expect(isCompactCommand("/compaction")).toBe(false);
  expect(isCompactCommand("/compactfoo")).toBe(false);
  expect(isCompactCommand("/new")).toBe(false);
});

test("commands are available only on the CLIs that accept them", () => {
  for (const agent of ["pi", "claude", "codex", "opencode"]) {
    const state = pane(agent);
    expect(isCommandPane(state)).toBe(true);
    expect(commandAvailable("new", state, chat(50000))).toBe(true);
    expect(commandAvailable("compact", state, chat(50000))).toBe(true);
  }
  expect(isCommandPane(pane(null))).toBe(false);
  expect(commandAvailable("new", pane(null), chat(50000))).toBe(false);
});

test("a working agent cannot run a command", () => {
  expect(commandAvailable("new", pane("pi", "working"), chat(50000))).toBe(false);
  expect(commandAvailable("compact", pane("pi", "working"), chat(50000))).toBe(false);
});

test("an empty conversation has neither command", () => {
  const empty = snapshot(0, null);
  expect(conversationEmpty(empty)).toBe(true);
  expect(conversationEmpty(chat(0))).toBe(false);
  expect(conversationEmpty(null)).toBe(false);
  expect(commandAvailable("new", pane("pi"), empty)).toBe(false);
  expect(commandAvailable("compact", pane("pi"), empty)).toBe(false);
  expect(commandCandidates(pane("pi"), "/", empty)).toEqual([]);
});

test("an unknown or compacted conversation is not empty", () => {
  // 読み込み前と会話を持たない CLI は空かどうか分からない。押せて失敗する側に倒す。
  expect(commandAvailable("new", pane("pi"), null)).toBe(true);
  expect(commandAvailable("compact", pane("pi"), null)).toBe(true);
  // compaction だけがある状態（opencode の圧縮直後）は空ではない。new は使える。
  expect(commandAvailable("new", pane("pi"), snapshot(0, 0))).toBe(true);
  expect(commandAvailable("compact", pane("pi"), snapshot(0, 0))).toBe(false);
});

test("compact is unavailable while the history is too small to compact", () => {
  expect(commandAvailable("compact", pane("pi"), chat(19999))).toBe(false);
  expect(commandAvailable("compact", pane("pi"), chat(20000))).toBe(true);
  // tokens が無いときは判定できないので押せる側に倒す。
  expect(commandAvailable("compact", pane("pi"), chat(null))).toBe(true);
  expect(commandAvailable("compact", pane("pi"), null)).toBe(true);
  // new は履歴のトークン数に依存しない。
  expect(commandAvailable("new", pane("pi"), chat(0))).toBe(true);
});

test("each menu item reports its own block reason", () => {
  expect(commandBlockReasonFor("new", null)).toBeNull();
  expect(commandBlockReasonFor("new", chat(50000))).toBeNull();
  expect(commandBlockReasonFor("new", snapshot(0, null))).toBe("empty");
  // 履歴が小さくても、新しい会話は始められる。
  expect(commandBlockReasonFor("new", chat(19999))).toBeNull();
  expect(commandBlockReasonFor("new", snapshot(0, 0))).toBeNull();
  expect(commandBlockReasonFor("compact", chat(19999))).toBe("history");
  expect(commandBlockReasonFor("compact", snapshot(0, 0))).toBe("compacted");
  expect(commandBlockReasonFor("compact", snapshot(0, null))).toBe("empty");
});

test("a slash without whitespace narrows the candidates", () => {
  expect(commandCandidates(pane("pi"), "/", chat(50000))).toEqual(["new", "compact"]);
  expect(commandCandidates(pane("pi"), "/n", chat(50000))).toEqual(["new"]);
  // iOS は入力の先頭を大文字にする。それでも候補を出す。
  expect(commandCandidates(pane("pi"), "/N", chat(50000))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/new", chat(50000))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/c", chat(50000))).toEqual(["compact"]);
  expect(commandCandidates(pane("pi"), "/COMPACT", chat(50000))).toEqual(["compact"]);
});

test("a small history hides compact, an unknown size keeps it", () => {
  // pi の既定（20000 トークン）未満では /compact が失敗する。
  expect(commandCandidates(pane("pi"), "/", chat(19999))).toEqual(["new"]);
  expect(commandCandidates(pane("pi"), "/c", chat(19999))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/", chat(20000))).toEqual(["new", "compact"]);
  // snapshot か tokens が無いときは判定できないので出し、押せて失敗する側に倒す。
  expect(commandCandidates(pane("pi"), "/", null)).toEqual(["new", "compact"]);
  expect(commandCandidates(pane("pi"), "/", chat(null))).toEqual(["new", "compact"]);
});

test("the threshold reads the context, not the agent", () => {
  // 閾値は agent ではなく context の有無で決める。context を持つ CLI（現在は pi と
  // opencode）には pi の既定値がそのまま適用される。claude は今 context を持たないが、
  // 判定が agent に依存しないことをここで見る。
  expect(commandCandidates(pane("claude"), "/c", chat(1000))).toEqual([]);
  expect(commandCandidates(pane("claude"), "/c", null)).toEqual(["compact"]);
  expect(commandCandidates(pane("opencode"), "/c", chat(1000))).toEqual([]);
  expect(commandCandidates(pane("opencode"), "/c", null)).toEqual(["compact"]);
});

test("text, arguments and near misses are not candidates", () => {
  expect(commandCandidates(pane("pi"), "", chat(50000))).toEqual([]);
  // 引数を取る形は同じ経路では送れない。本文として扱う。
  expect(commandCandidates(pane("pi"), "/compact 指示", chat(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/newx", chat(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "/nee", chat(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), "こんにちは /new", chat(50000))).toEqual([]);
  expect(commandCandidates(pane("pi"), " /new", chat(50000))).toEqual([]);
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
