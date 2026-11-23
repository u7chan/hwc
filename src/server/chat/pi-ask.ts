import { randomUUID } from "node:crypto";
import { type FileHandle, open, rename, rm, writeFile } from "node:fs/promises";
import {
  ASK_ANSWER_MAX_BYTES,
  ASK_OPTION_MAX,
  ASK_OPTIONS_MAX,
  ASK_OPTIONS_MIN,
  ASK_PENDING_MAX_BYTES,
  ASK_QUESTION_MAX,
  ASK_TEXT_MAX,
} from "../../shared/ask-user";

// mypi の ask_user がセッションの隣に置く pending と、hwc が返す answer の契約
// （docs/adr/pi-integration.md）。壊れたファイル・未知の v は「無いもの」として扱い、
// 会話の取得を止めない。
const PENDING_SUFFIX = ".ask.json";
const ANSWER_SUFFIX = ".ask.answer.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /\p{Cc}/u;

export type AskPending = {
  id: string;
  question: string;
  options: string[] | null;
};

export type AskAnswer = { kind: "option"; label: string } | { kind: "text"; text: string };

export function askPendingPath(sessionPath: string): string {
  return `${sessionPath}${PENDING_SUFFIX}`;
}

export function askAnswerPath(sessionPath: string): string {
  return `${sessionPath}${ANSWER_SUFFIX}`;
}

export function parseAskPending(value: unknown): AskPending | null {
  const record = asRecord(value);
  if (record === null || record.v !== 1) return null;
  const id = askId(record.id);
  if (id === null) return null;
  const question = askQuestion(record.question);
  if (question === null) return null;
  const options = askOptions(record.options);
  if (options === undefined) return null;
  return { id, question, options };
}

// pending.options は自由入力のとき必ず null。省略や空配列は形の不一致として捨てる。
function askOptions(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  if (value.length < ASK_OPTIONS_MIN || value.length > ASK_OPTIONS_MAX) return undefined;
  const options: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const option = item.trim();
    if (option === "" || codePoints(option) > ASK_OPTION_MAX) return undefined;
    if (CONTROL.test(option)) return undefined;
    if (options.includes(option)) return undefined;
    options.push(option);
  }
  return options;
}

// CRLF / CR は LF に直してから trim する。改行は許可し、他の制御文字は捨てる。
export function askQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const question = value.replace(/\r\n?/g, "\n").trim();
  if (question === "" || codePoints(question) > ASK_QUESTION_MAX) return null;
  if (CONTROL.test(question.replaceAll("\n", ""))) return null;
  return question;
}

// 読み手と書き手で同じ検証を通す。answer の id は pending と完全一致させる。
export function parseAskAnswer(value: unknown, pending: AskPending): AskAnswer | null {
  const record = asRecord(value);
  if (record === null || record.v !== 1 || record.id !== pending.id) return null;
  const answer = asRecord(record.answer);
  if (answer === null) return null;
  if (answer.kind === "option") {
    if (pending.options === null || typeof answer.label !== "string") return null;
    if (!pending.options.includes(answer.label)) return null;
    return { kind: "option", label: answer.label };
  }
  if (answer.kind === "text") {
    if (pending.options !== null) return null;
    const text = askText(answer.text);
    return text === null ? null : { kind: "text", text };
  }
  return null;
}

// 自由入力は trim と長さだけを正規化し、内部の改行とタブは保つ。
export function askText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || codePoints(text) > ASK_TEXT_MAX) return null;
  if (CONTROL.test(text.replaceAll("\n", "").replaceAll("\t", ""))) return null;
  return text;
}

// JSON を parse する前にサイズを見る。読み取りの失敗は無いものとして扱う。
export async function readAsk(sessionPath: string): Promise<AskPending | null> {
  const raw = await readBounded(askPendingPath(sessionPath), ASK_PENDING_MAX_BYTES);
  if (raw === null) return null;
  try {
    return parseAskPending(JSON.parse(raw));
  } catch {
    return null;
  }
}

// 書き込み前の再照合に使う。壊れた answer や、別の質問への answer は無いものとして扱い、
// 同じ id でも契約に合わない本文なら重複とみなさない。
export async function readAskAnswer(
  sessionPath: string,
  pending: AskPending,
): Promise<AskAnswer | null> {
  const raw = await readBounded(askAnswerPath(sessionPath), ASK_ANSWER_MAX_BYTES);
  if (raw === null) return null;
  try {
    return parseAskAnswer(JSON.parse(raw), pending);
  } catch {
    return null;
  }
}

// 1 行 JSON + 改行 1 つ。tmp に書いて rename する。失敗した tmp は残さない。
export async function writeAskAnswer(
  sessionPath: string,
  id: string,
  answer: AskAnswer,
): Promise<void> {
  const path = askAnswerPath(sessionPath);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ v: 1, id, answer })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {
      // 消せない tmp を残しても、次の書き込みは別の一意な名前を使う。
    });
    throw error;
  }
}

async function readBounded(path: string, limit: number): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => {
        // 読み取りは終わっている。閉じ損ねても次の要求で開き直せる。
      });
    }
  }
}

function askId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
