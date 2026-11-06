import type { ChatContext, ChatSnapshot } from "../server/chat/contract";
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

// セルの外にあるメニューへ、実行可否と実行だけを渡す。
// 会話と圧縮は PaneDetail、未完了の送信は App が持ち、入口ごとに状態を分けない。
// メニューを開いた後に SSE や送信で状態が変わっても、最新値で判定できるよう
// available は現在の pane を受け取り、実行に使う値は PaneDetail 側の ref から読む。
export type PaneCommandHandle = {
  available: (id: CommandId, pane: PaneState) => boolean;
  busy: () => boolean;
  // メニューの注記用。押せない理由を 1 つだけ返す。
  blockReason: () => CommandBlockReason | null;
  run: (id: CommandId) => void;
};

export function isCommandPane(pane: PaneState): boolean {
  return COMMAND_AGENTS.has(agentGlyph(pane.agent));
}

export function commandText(id: CommandId): string {
  return AGENT_COMMANDS[id].text;
}

export function isNewSessionCommand(text: string): boolean {
  return text.trim() === commandText("new");
}

// 直接入力の /compact を、チップを通さない経路でも圧縮として扱うための判定。
// pi は trim 後に `/compact` と完全一致するか、`/compact `（半角空白）で始まるときだけ
// コマンドにする。改行で指示を続けた本文や、添付注記が後ろに付く本文はコマンドにならない。
export function isCompactCommand(text: string): boolean {
  const trimmed = text.trim();
  const command = commandText("compact");
  return trimmed === command || trimmed.startsWith(`${command} `);
}

// pi は直前のエントリが compaction のとき、手動 /compact を Already compacted で即失敗する。
// 返ってきた messages の後ろに compaction がある（後ろに発話がない）状態を圧縮済みとみなす。
export function compactAlreadyDone(snapshot: ChatSnapshot): boolean {
  return snapshot.compaction !== null && snapshot.compaction.index === snapshot.messages.length;
}

export const COMPACTED_NOTICE = "会話は圧縮済みです";

export type CommandBlockReason = "empty" | "history" | "compacted";

export const COMMAND_BLOCK_NOTES: Readonly<Record<CommandBlockReason, string>> = {
  empty: "会話が始まると使えます",
  history: "会話が小さいうちは圧縮できません",
  compacted: COMPACTED_NOTICE,
};

export function compactHistoryBlocked(context: ChatContext | null): boolean {
  const tokens = context === null ? null : context.tokens;
  return tokens !== null && tokens < COMPACT_MIN_TOKENS;
}

// 会話のスナップショットが読めていて、まだ何も無い状態。空の会話では /new は同じ空の
// セッションを作り直すだけで、/compact は対象が無い。snapshot が無いとき（読み込み前、
// 会話を持たない CLI）は空かどうか分からないので、空とは扱わない。
export function conversationEmpty(snapshot: ChatSnapshot | null): boolean {
  return snapshot !== null && snapshot.messages.length === 0 && snapshot.compaction === null;
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
  snapshot: ChatSnapshot | null,
): boolean {
  if (pane.agentStatus === "working") return false;
  if (!isCommandPane(pane)) return false;
  if (conversationEmpty(snapshot)) return false;
  if (id !== "compact") return true;
  if (snapshot !== null && compactAlreadyDone(snapshot)) return false;
  return !compactHistoryBlocked(snapshot?.context ?? null);
}

// メニューの注記用。空の会話では 2 つとも使えないので、compact だけの理由より先に返す。
export function commandBlockReason(snapshot: ChatSnapshot | null): CommandBlockReason | null {
  if (conversationEmpty(snapshot)) return "empty";
  if (snapshot !== null && compactAlreadyDone(snapshot)) return "compacted";
  if (compactHistoryBlocked(snapshot?.context ?? null)) return "history";
  return null;
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
  snapshot: ChatSnapshot | null,
): readonly CommandId[] {
  return matchCommands(draft).filter((id) => commandAvailable(id, pane, snapshot));
}
