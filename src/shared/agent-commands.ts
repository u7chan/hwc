// CLI へ送る文字列。ラベルは client が持つ。4 つの CLI が同じ名前で受け付けることを
// 確かめてから増やす。BFF も同じ文字列で OpenCode の入力かどうかを見る。
export const AGENT_COMMAND_TEXTS = {
  new: "/new",
  compact: "/compact",
} as const;

export type AgentCommandId = keyof typeof AGENT_COMMAND_TEXTS;

export function commandText(id: AgentCommandId): string {
  return AGENT_COMMAND_TEXTS[id];
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
