import { stripAttachedFiles } from "../../shared/attachments";
import { asRecord, nonEmptyText } from "../../shared/json";
import type { ChatMessage, ChatUsage } from "./contract";

export type SessionCompaction = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number | null;
  at: number;
};

export type SessionAskQuestion = {
  toolCallId: string;
  question: string;
  // 質問カードと同じ生のラベル。履歴では選択済み・推奨を表示する。
  options: string[] | null;
  recommended: string | null;
  at: number;
};
export type SessionAskResult = {
  toolCallId: string;
  status: string;
  // mypi が pending 質問 id を details に残す。中断時は空文字なので null になる。
  askId: string | null;
  // 回答が選択肢か自由入力か。不明な値は null。
  kind: "option" | "text" | null;
  // answered 以外は null。Esc・中断・失敗も呼び出しを消費するために保持する。
  answer: string | null;
  at: number;
};

export type SessionEntry = {
  id: string;
  parentId: string | null;
  // 1 エントリが 1 行とは限らない。失敗した assistant は本文と失敗の 2 行になる。
  messages: ChatMessage[];
  // ask_user の tool call と result。表示用の Q&A を合成する材料で、messages には含めない。
  askQuestions: SessionAskQuestion[];
  askResults: SessionAskResult[];
  model: string | null;
  provider: string | null;
  effort: string | null;
  usageTokens: number | null;
  usage: ChatUsage | null;
  invalidatesUsage: boolean;
  // 材料の有無とは別に、compaction エントリかどうかを持つ。壊れた最新を古いもので
  // 埋めないため、境界の位置と材料を別々に知る必要がある。
  compactionEntry: boolean;
  compaction: SessionCompaction | null;
};

type Projected = {
  messages: ChatMessage[];
  model: string | null;
  provider: string | null;
  effort: string | null;
  usageTokens: number | null;
  usage: ChatUsage | null;
};

// 要約の無い compaction は材料にしない。要約だけ出して窓がずれる状態を作らないため。
export function projectCompaction(record: Record<string, unknown>): SessionCompaction | null {
  const summary = nonEmptyText(record.summary);
  const firstKeptEntryId = nonEmptyText(record.firstKeptEntryId);
  if (summary === null || firstKeptEntryId === null) return null;
  return {
    summary,
    firstKeptEntryId,
    tokensBefore: finiteNumber(record.tokensBefore),
    at: messageAt(record.timestamp, record.timestamp),
  };
}

export function project(
  id: string,
  message: Record<string, unknown>,
  entryTimestamp: unknown,
): Projected {
  const at = messageAt(message.timestamp, entryTimestamp);

  if (message.role === "user") {
    const { text, attachments } = stripAttachedFiles(userText(message.content));
    // 注記を落とした後に本文が空でも、添付があればメッセージとして残す。
    const shown = text === "" && attachments.length === 0;
    return {
      messages: shown
        ? []
        : [
            {
              id,
              role: "user",
              text,
              at,
              ...(attachments.length === 0
                ? {}
                : { attachments: attachments.map((name) => ({ name, size: null })) }),
            },
          ],
      model: null,
      provider: null,
      effort: null,
      usageTokens: null,
      usage: null,
    };
  }

  if (message.role === "assistant") {
    // ツール実行だけの返答は本文が空になる。会話としては出さないが、model と
    // thinkingLevel と usage は最新の値として使う。
    const text = assistantText(message.content);
    const usageTokens = assistantUsageTokens(message);
    const messages: ChatMessage[] = [];
    if (text !== "") messages.push({ id, role: "agent", text, at });
    // 失敗したターンは本文が空の assistant として残る。拾わないと、Web では送った
    // メッセージに何も返らないまま idle に戻り、送信が届いていないように見える。
    const failed = assistantError(message);
    if (failed !== null) messages.push({ id: `${id}:error`, role: "error", text: failed, at });
    return {
      messages,
      model: nonEmptyText(message.model),
      provider: nonEmptyText(message.provider),
      effort: nonEmptyText(message.thinkingLevel),
      usageTokens,
      usage: usageTokens === null ? null : usageParts(asRecord(message.usage)),
    };
  }

  return {
    messages: [],
    model: null,
    provider: null,
    effort: null,
    usageTokens: null,
    usage: null,
  };
}

// 中断は利用者の操作なので失敗にしない。止めたのにエラーが残ると、次の一手を誤る。
function assistantError(message: Record<string, unknown>): string | null {
  if (message.stopReason !== "error") return null;
  return nonEmptyText(message.errorMessage);
}

function usageParts(usage: Record<string, unknown> | null): ChatUsage | null {
  if (usage === null) return null;
  const part = (value: unknown) => {
    const n = finiteNumber(value);
    return n !== null && n >= 0 ? n : null;
  };
  const result = {
    input: part(usage.input),
    output: part(usage.output),
    cacheRead: part(usage.cacheRead),
    cacheWrite: part(usage.cacheWrite),
    reasoning: null,
  };
  return Object.values(result).some((n) => n !== null) ? result : null;
}

// pi の getAssistantUsage と同じ条件。中断・失敗の usage と全ゼロの usage は現在の
// コンテキスト量を表さない。
function assistantUsageTokens(message: Record<string, unknown>): number | null {
  if (message.stopReason === "aborted" || message.stopReason === "error") return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const total = contextTokens(usage);
  return total > 0 ? total : null;
}

// pi の calculateContextTokens と同じ。totalTokens が無い・0 のときは内訳を足す。
function contextTokens(usage: Record<string, unknown>): number {
  const total = finiteNumber(usage.totalTokens);
  if (total !== null && total !== 0) return total;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => {
    return sum + (finiteNumber(usage[key]) ?? 0);
  }, 0);
}

export function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  let images = 0;
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") text += record.text;
    else if (record.type === "image") images += 1;
  }
  // 画像だけを送ったときは本文が無い。添付があったことだけを伝える。
  if (text === "" && images > 0) return "[画像]";
  return text;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text;
}

// mypi の normalizeQuestion と同じ改行正規化。pending の本文と合成質問を同じ形にする。
function normalizeQuestionText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// 選択肢は表示用。mypi が検証済みでも、壊れた値で履歴を失わないよう文字列だけを拾う。
function askOptionsFromArgs(args: Record<string, unknown> | null): {
  options: string[] | null;
  recommended: string | null;
} {
  if (args === null || !Array.isArray(args.options)) {
    return { options: null, recommended: null };
  }
  const options = args.options.flatMap((value) =>
    typeof value === "string" && value.trim() !== "" ? [value.trim()] : [],
  );
  if (options.length === 0) return { options: null, recommended: null };
  const recommended =
    typeof args.recommended === "string" && options.includes(args.recommended.trim())
      ? args.recommended.trim()
      : null;
  return { options, recommended };
}

// toolCall の arguments は通常オブジェクト。壊れた文字列は質問なしとして扱う。
export function askQuestionsFromContent(content: unknown, at: number): SessionAskQuestion[] {
  if (!Array.isArray(content)) return [];
  const questions: SessionAskQuestion[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "toolCall" || record.name !== "ask_user") continue;
    const toolCallId = nonEmptyText(record.id);
    const args = asRecord(record.arguments);
    const question = typeof args?.question === "string" ? normalizeQuestionText(args.question) : "";
    if (toolCallId === null || question === "") continue;
    questions.push({ toolCallId, ...askOptionsFromArgs(args), question, at });
  }
  return questions;
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text;
}

// ask_user の result は、回答済みでなくても呼び出しを消費するために拾う。同じ toolCallId が
// 別の質問で再利用されても、Esc した質問を回答済みにしないため。合成するのは answered だけ。
export function askResultsFromMessage(
  message: Record<string, unknown>,
  at: number,
): SessionAskResult[] {
  if (message.role !== "toolResult" || message.toolName !== "ask_user") return [];
  const toolCallId = nonEmptyText(message.toolCallId);
  if (toolCallId === null) return [];
  const details = asRecord(message.details);
  const status = typeof details?.status === "string" ? details.status : "other";
  const askId = nonEmptyText(details?.askId);
  const kind = details?.kind === "option" || details?.kind === "text" ? details.kind : null;
  if (status !== "answered") return [{ toolCallId, status, askId, kind, answer: null, at }];
  const text = toolResultText(message.content);
  const prefix = "ユーザーの回答: ";
  const answer = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return [
    {
      toolCallId,
      status,
      askId,
      kind,
      answer: answer.trim() === "" ? null : answer,
      at,
    },
  ];
}

export function messageAt(value: unknown, entryTimestamp: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof entryTimestamp === "string") {
    const parsed = Date.parse(entryTimestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
