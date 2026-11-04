import type { CommandId } from "./commands";
import { agentGlyph } from "./select";

// 選択範囲は trim 済みの生テキストで持ち、送信のときだけ引用の記号を付ける。
// 前後の空行を落とし、最初と最後の行の端の空白だけを整える。行の中の空白は本文の一部なので残す。
export function normaliseQuote(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n").trim();
}

export function quoteLines(quote: string): string {
  return quote
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

// 引用と本文の間は空行 1 つ。空の本文は行を足さない。引用が無ければ本文だけを送る。
export function composeReply(quote: string, draft: string): string {
  const selection = normaliseQuote(quote);
  if (selection === "") return draft;
  const quoted = quoteLines(selection);
  return draft.trim() === "" ? quoted : `${quoted}\n\n${draft}`;
}

export type ReplySplit = { quote: string | null; body: string };

// 送信後の本文から、先頭の blockquote だけを引用カードとして取り出す。
// 手書きの blockquote も同じ形なので引用として扱い、本文中の `>` には触れない。
export function splitQuote(text: string): ReplySplit {
  const lines = text.split("\n");
  const quoted: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) {
    quoted.push(lines[index].replace(/^> ?/, ""));
    index += 1;
  }
  if (quoted.length === 0) return { quote: null, body: text };
  const quote = normaliseQuote(quoted.join("\n"));
  // `>` だけの本文は引用の中身が無い。引用カードにせず、そのまま本文として出す。
  if (quote === "") return { quote: null, body: text };
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return { quote, body: lines.slice(index).join("\n").trimEnd() };
}

export type ComposeState = {
  uploading: boolean;
  chip: CommandId | null;
  replying: boolean;
  draft: string;
  attachments: number;
  reply: string | null;
};

// 停止は実行中の既知エージェントだけ。入力が残っていれば、その送信（steering）を優先する。
export type StopState = {
  replying: boolean;
  agent: string | null;
  draft: string;
  attachments: number;
  reply: string | null;
  chip: CommandId | null;
};

export function canStop(state: StopState): boolean {
  return (
    state.replying &&
    agentGlyph(state.agent) !== "generic" &&
    state.draft.trim() === "" &&
    state.attachments === 0 &&
    state.reply === null &&
    state.chip === null
  );
}

// 引用だけでも送れる。アップロード中は添付が揃うまで待ち、チップは会話が動いていないときだけ。
export function canSend(state: ComposeState): boolean {
  if (state.uploading) return false;
  if (state.chip !== null) return !state.replying;
  return state.draft.trim() !== "" || state.attachments > 0 || state.reply !== null;
}
