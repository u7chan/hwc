import type { PaneState } from "../server/herdr/state";
import { agentGlyph } from "./select";

export type CommandId = "new" | "compact";

type AgentCommand = { label: string; text: string };

// ペインへ送る文字列を持つのはここだけ。増やすときは、4 つの CLI が同じ名前で
// 受け付けることを確かめてから 1 行足す。
export const AGENT_COMMANDS: Readonly<Record<CommandId, AgentCommand>> = {
  new: { label: "新しいセッション", text: "/new" },
  compact: { label: "コンパクト", text: "/compact" },
};

const COMMAND_IDS: readonly CommandId[] = ["new", "compact"];

// 4 つの CLI は /new と /compact を持つ。generic とシェル（agent が null）は持たない。
const COMMAND_AGENTS: ReadonlySet<string> = new Set(["pi", "claude", "codex", "opencode"]);

export function commandText(id: CommandId): string {
  return AGENT_COMMANDS[id].text;
}

export function commandLabel(id: CommandId): string {
  return AGENT_COMMANDS[id].label;
}

// 空白が入った時点でコマンドではなく本文（`/compact 指示` など）。iOS が先頭を
// 大文字にしても候補が出るよう、比較は小文字で行う。
function matchCommands(draft: string): readonly CommandId[] {
  const typed = draft.toLowerCase();
  if (!typed.startsWith("/") || /\s/.test(typed)) return [];
  return COMMAND_IDS.filter((id) => commandText(id).startsWith(typed));
}

// 実行中は候補を出さない。走っている会話へコマンドを割り込ませない。
export function commandCandidates(pane: PaneState, draft: string): readonly CommandId[] {
  if (pane.agentStatus === "working") return [];
  if (!COMMAND_AGENTS.has(agentGlyph(pane.agent))) return [];
  return matchCommands(draft);
}
