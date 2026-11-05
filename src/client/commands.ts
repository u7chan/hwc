import type { ChatContext } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { agentGlyph } from "./select";

export type CommandId = "new" | "compact";

type AgentCommand = { label: string; text: string };

// ペインへ送る文字列を持つのはここだけ。増やすときは、4 つの CLI が同じ名前で
// 受け付けることを確かめてから 1 行足す。
export const AGENT_COMMANDS: Readonly<Record<CommandId, AgentCommand>> = {
  new: { label: "新しいセッション", text: "/new" },
  compact: { label: "会話を圧縮", text: "/compact" },
};

const COMMAND_IDS: readonly CommandId[] = ["new", "compact"];

// 4 つの CLI は /new と /compact を持つ。generic とシェル（agent が null）は持たない。
const COMMAND_AGENTS: ReadonlySet<string> = new Set(["pi", "claude", "codex", "opencode"]);

// pi の keepRecentTokens の既定値の写し。pi 側が変われば追随が要る。
const COMPACT_MIN_TOKENS = 20000;

// セルの外にあるメニューへ、実行可否と実行だけを渡す。状態は PaneDetail が持つ。
export type PaneCommandHandle = {
  available: (id: CommandId) => boolean;
  busy: () => boolean;
  run: (id: CommandId) => void;
};

export function isCommandPane(pane: PaneState): boolean {
  return COMMAND_AGENTS.has(agentGlyph(pane.agent));
}

export function commandText(id: CommandId): string {
  return AGENT_COMMANDS[id].text;
}

export function commandLabel(id: CommandId): string {
  return AGENT_COMMANDS[id].label;
}

// 送信は { text, keys: ["enter"] } の 1 回なので、途中の改行は TUI の途中送信に
// なり得る。指示は 1 行に畳んでから渡す。
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function commandSendText(id: CommandId, draft: string): string {
  const base = commandText(id);
  if (id !== "compact") return base;
  const instructions = singleLine(draft);
  return instructions === "" ? base : `${base} ${instructions}`;
}

// compact のチップ中は入力欄が指示の入力になるので、打っても解除しない。
export function chipOnInput(chip: CommandId | null): CommandId | null {
  return chip === "compact" ? chip : null;
}

// compact は履歴が小さいと失敗し、hwc には結果が来ない。閾値未満では押させない。
// tokens が null（compaction 直後など）は判定できないので押せる側に倒す。
export function commandAvailable(
  id: CommandId,
  pane: PaneState,
  context: ChatContext | null,
): boolean {
  if (pane.agentStatus === "working") return false;
  if (!isCommandPane(pane)) return false;
  if (id !== "compact") return true;
  const tokens = context === null ? null : context.tokens;
  return tokens === null || tokens >= COMPACT_MIN_TOKENS;
}

// 空白が入った時点でコマンドではなく本文（`/compact 指示` など）。iOS が先頭を
// 大文字にしても候補が出るよう、比較は小文字で行う。
function matchCommands(draft: string): readonly CommandId[] {
  const typed = draft.toLowerCase();
  if (!typed.startsWith("/") || /\s/.test(typed)) return [];
  return COMMAND_IDS.filter((id) => commandText(id).startsWith(typed));
}

// 履歴が小さいと pi の /compact は失敗し、hwc には何も出ない。明らかに小さい間は
// 候補から外す。tokens が null（compaction 直後など）は判定できないので出し、
// 押せて失敗する側に倒す。実行中は候補を出さない。走っている会話へ割り込ませない。
export function commandCandidates(
  pane: PaneState,
  draft: string,
  context: ChatContext | null,
): readonly CommandId[] {
  return matchCommands(draft).filter((id) => commandAvailable(id, pane, context));
}
