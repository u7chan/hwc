import type { ChatPending, ChatPendingQuestion } from "./contract";

// 応答待ちのカードは 1 問ずつ画面に収める。モデルが書いた文字列の上限はここで決め、
// 超えた分は切り、制御文字を落として改行を空白にする。
const PENDING_MAX_QUESTIONS = 4;
const PENDING_MAX_OPTIONS = 10;
const PENDING_QUESTION_MAX = 2_000;
const PENDING_HEADER_MAX = 100;
const PENDING_LABEL_MAX = 500;
const PENDING_DESCRIPTION_MAX = 1_000;
const PENDING_SUMMARY_MAX = 200;
const PENDING_TOOL_MAX = 100;

// 承認待ちの 1 行要約に使う input の欄。input 全体は出さない（Write の content など、
// 本文が画面と通信に乗ってしまう）。ここに無いツールは要約を持たない。
const SUMMARY_FIELDS: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  WebFetch: "url",
};

export const ASK_USER_QUESTION = "AskUserQuestion";

// 壊れた input はカードにしない。質問の代表としても出さない。
export function questionPending(toolUseId: string, input: unknown): ChatPending | null {
  const questions = pendingQuestions(input);
  if (questions === null) return null;
  return { kind: "question", toolUseId, tool: ASK_USER_QUESTION, questions };
}

// summary は toolSummary の結果か、保存された値。どちらも上限と正規化を通す。
export function toolPending(toolUseId: string, name: string, summary: unknown): ChatPending | null {
  const tool = pendingText(name, PENDING_TOOL_MAX);
  if (tool === "") return null;
  const text = pendingText(summary, PENDING_SUMMARY_MAX);
  return { kind: "tool", toolUseId, tool, summary: text === "" ? null : text };
}

export function toolSummary(name: string, input: unknown): string | null {
  const field = SUMMARY_FIELDS[name];
  if (field === undefined) return null;
  const record = asRecord(input);
  if (record === null) return null;
  const summary = pendingText(record[field], PENDING_SUMMARY_MAX);
  return summary === "" ? null : summary;
}

// 保存されたカードを読み直すときの検証。書き手と同じ上限と正規化を通すので、手で書き換えた
// ファイルや、上限の違う版が書いたファイルでも、画面に出る形は変わらない。
export function parsePending(value: unknown): ChatPending | null {
  const record = asRecord(value);
  if (record === null || typeof record.toolUseId !== "string" || record.toolUseId === "") {
    return null;
  }
  if (record.kind === "question") return questionPending(record.toolUseId, record);
  if (record.kind === "tool" && typeof record.tool === "string") {
    return toolPending(record.toolUseId, record.tool, record.summary);
  }
  return null;
}

function pendingQuestions(input: unknown): ChatPendingQuestion[] | null {
  const record = asRecord(input);
  if (record === null) return null;
  const raw = record.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: ChatPendingQuestion[] = [];
  for (const value of raw.slice(0, PENDING_MAX_QUESTIONS)) {
    const question = pendingQuestion(value);
    if (question === null) return null;
    questions.push(question);
  }
  return questions;
}

function pendingQuestion(value: unknown): ChatPendingQuestion | null {
  const record = asRecord(value);
  if (record === null) return null;
  const question = pendingText(record.question, PENDING_QUESTION_MAX);
  if (question === "") return null;
  const raw = record.options;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const options: ChatPendingQuestion["options"] = [];
  for (const value of raw.slice(0, PENDING_MAX_OPTIONS)) {
    const option = asRecord(value);
    if (option === null) return null;
    const label = pendingText(option.label, PENDING_LABEL_MAX);
    if (label === "") return null;
    const description = pendingText(option.description, PENDING_DESCRIPTION_MAX);
    options.push({ label, description: description === "" ? null : description });
  }

  const header = pendingText(record.header, PENDING_HEADER_MAX);
  return {
    question,
    header: header === "" ? null : header,
    multiSelect: record.multiSelect === true,
    options,
  };
}

// モデルが書いた文字列として扱う。制御文字を落として改行を空白にし、長さで切るだけにする。
// Markdown や HTML は、描く側でテキストとして置く。
function pendingText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value
    .replace(/\p{Cc}/gu, (char) => (/[\n\r\t]/.test(char) ? " " : ""))
    .replace(/ {2,}/g, " ")
    .trim();
  return Array.from(flat).slice(0, max).join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
