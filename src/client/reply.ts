import type { CommandId } from "./commands";
import { agentGlyph } from "./select";

// 選択範囲は trim 済みの生テキストで受け取り、引用の記号を付けて入力欄の下書きへ足す。
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

export type QuoteAppend = { text: string; caret: number };

// 引用は入力欄の末尾へ、空行 1 つを挟んで足す。引用の後ろにも空行を 1 つ残し、
// そこへカーソルを移す。空の選択は下書きを変えない。
export function appendQuote(draft: string, quote: string): QuoteAppend {
  const selection = normaliseQuote(quote);
  if (selection === "") return { text: draft, caret: draft.length };
  const quoted = quoteLines(selection);
  const base = draft.trim() === "" ? "" : draft.replace(/\n+$/, "");
  const text = base === "" ? `${quoted}\n\n` : `${base}\n\n${quoted}\n\n`;
  return { text, caret: text.length };
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
};

// 停止は実行中の既知エージェントと、前景プロセスが動いているシェル。入力が残っていれば、
// その送信（steering）を優先する。
export type StopState = {
  replying: boolean;
  agent: string | null;
  running: boolean;
  draft: string;
  attachments: number;
  chip: CommandId | null;
};

export function canStop(state: StopState): boolean {
  if (state.draft.trim() !== "" || state.attachments !== 0 || state.chip !== null) {
    return false;
  }
  if (state.replying) return agentGlyph(state.agent) !== "generic";
  // シェルの C-c は前景プロセスを止める。プロンプトで押しても入力行が消えるだけなので、
  // 何か動いているときだけ停止ボタンにする。
  return state.agent === null && state.running;
}

// 引用も下書きの一部として数える。アップロード中は添付が揃うまで待ち、
// チップは会話が動いていないときだけ。
export function canSend(state: ComposeState): boolean {
  if (state.uploading) return false;
  if (state.chip !== null) return !state.replying;
  return state.draft.trim() !== "" || state.attachments > 0;
}
