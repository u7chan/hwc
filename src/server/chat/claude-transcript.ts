import { type FileHandle, open } from "node:fs/promises";
import { asRecord, nonEmptyText } from "../../shared/json";
import { ChatUnavailableError } from "./errors";

// transcript は追記され続ける。16MB を超えるセッションは末尾だけを読み、先頭を切ったことを
// truncated で知らせる。増分読みは、大きなセッションで表示が重いと分かってから別 Issue で足す。
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

// TUI のローカルコマンド（`/model` や `/theme`）の記録は利用者の発話ではない。会話に混ぜると
// 会話の流れがコマンドの結果で埋まる。
const LOCAL_COMMAND_TAGS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

export const LOCAL_COMMAND_OUTPUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

// 利用者が Esc で中断したときに CLI が user の本文として書く固定の記録。発話ではない。
// 質問に答えるときは hwc が Esc を送るので、毎回これが残る（docs/adr/claude-integration.md）。
export const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

// API を呼ばずに失敗したターンの記録に付くモデル名。表示するモデルではない。
export const SYNTHETIC_MODEL = "<synthetic>";

// メインスレッドの要求だけが会話の応答を待つ。sdk の要求は本流の段階ではない。
export const MAIN_THREAD_SOURCE = "repl_main_thread";

// transcript の message.content を、会話と段階に使う種類だけに絞った形。tool_result の
// 本文や画像の base64 は抱えない（大きなセッションでも射影を膨らませないため）。
export type TranscriptBlock = {
  type: string;
  // text / thinking
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  toolUseId?: string;
  isError?: boolean;
};

export type TranscriptContent = string | TranscriptBlock[] | null;

// 1 つの応答のキャッシュ使用量。書き込みの内訳は、形が読めない版では null にして
// 「1h と確認できない」と区別する。
export type TranscriptUsage = {
  cacheWrite: number;
  cacheRead: number;
  cacheWrite1h: number | null;
  cacheWrite5m: number | null;
};

export type TranscriptEntry = {
  // ファイル順の位置。ターンの起点より後ろの行だけを段階の判定に使う。
  index: number;
  type: string;
  // api-request は uuid を持たない。会話と枝は uuid のある行だけで作る。
  uuid: string | null;
  parentUuid: string | null;
  version: string | null;
  at: number;
  sidechain: boolean;
  meta: boolean;
  compactSummary: boolean;
  apiError: boolean;
  error: string | null;
  effort: string | null;
  message: {
    id: string | null;
    model: string | null;
    content: TranscriptContent;
    // 応答が終わったことを示す。中断・失敗・書き込み途中の行を完了応答と区別する。
    stopReason: string | null;
    usage: TranscriptUsage | null;
  } | null;
  // system 行の種類。圧縮の区切り（compact_boundary）を拾う。
  subtype: string | null;
  // 圧縮の境界は parentUuid を持たず、圧縮前の枝の葉をここにだけ残す。
  logicalParentUuid: string | null;
  // 圧縮の直前の文脈量。区切りの表示に使う。
  preTokens: number | null;
  // 要求と応答の対応。api-request の id と assistant の requestRef が一致する。
  requestId: string | null;
  querySource: string | null;
  requestRef: string | null;
  // TUI のダイアログで答えた AskUserQuestion の tool_result が持つ、質問文 → 答え。
  askAnswers: Readonly<Record<string, string>> | null;
};

export async function readTranscript(
  path: string,
  maxBytes: number,
): Promise<{ entries: TranscriptEntry[]; clipped: boolean; size: number; inode: number }> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new ChatUnavailableError("claude transcript was not found");
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ChatUnavailableError("claude transcript is not a file");
    const size = info.size;
    const length = Math.min(size, maxBytes);
    let bytesRead = 0;
    let text = "";
    if (length > 0) {
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, size - length);
      bytesRead = read.bytesRead;
      text = buffer.subarray(0, bytesRead).toString("utf8");
    }
    const parsed = parseTranscript(text, size > maxBytes);
    return { ...parsed, size, inode: info.ino };
  } catch (error) {
    if (error instanceof ChatUnavailableError) throw error;
    throw new ChatUnavailableError("claude transcript is not readable");
  } finally {
    await handle.close().catch(() => {
      // 読み取りは終わっている。閉じ損ねても次の要求で開き直せる。
    });
  }
}

export function parseTranscript(
  raw: string,
  clipped: boolean,
): { entries: TranscriptEntry[]; clipped: boolean } {
  const lines = raw.split("\n");
  // 末尾だけを読んだときは、先頭が行の途中のことがある。`{` で始まらない先頭行は捨てる。
  const first = clipped && !raw.startsWith("{") ? 1 : 0;
  const entries: TranscriptEntry[] = [];
  let objects = 0;

  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 書き込み途中の行だけを捨てる。ファイル全体を読めなくしない。
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) continue;
    objects += 1;
    const entry = toEntry(record, entries.length);
    if (entry !== null) entries.push(entry);
  }

  // 1 行も解釈できないファイルは transcript ではない。空として扱うと、会話が消えた理由が
  // 画面から分からなくなる。
  if (objects === 0 && first === 0 && raw.trim() !== "") {
    throw new ChatUnavailableError("claude transcript is unreadable");
  }
  return { entries, clipped };
}

function toEntry(record: Record<string, unknown>, index: number): TranscriptEntry | null {
  const type = record.type;
  if (typeof type !== "string") return null;
  const uuid = nonEmptyText(record.uuid);
  // 応答の対応は uuid を持たない api-request でしか取れない。それ以外の uuid の無い行は
  // 会話にも枝にも段階にも使わない。
  if (uuid === null && type !== "api-request") return null;
  const message = asRecord(record.message);
  return {
    index,
    type,
    uuid,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
    version: nonEmptyText(record.version),
    at: timestampOf(record.timestamp),
    sidechain: record.isSidechain === true,
    meta: record.isMeta === true,
    compactSummary: record.isCompactSummary === true,
    apiError: record.isApiErrorMessage === true,
    error: nonEmptyText(record.error),
    effort: nonEmptyText(record.perTurnEffort),
    message:
      message === null
        ? null
        : {
            id: nonEmptyText(message.id),
            model: nonEmptyText(message.model),
            content: projectContent(message.content),
            stopReason: nonEmptyText(message.stop_reason),
            usage: usageOf(message),
          },
    subtype: nonEmptyText(record.subtype),
    logicalParentUuid: nonEmptyText(record.logicalParentUuid),
    preTokens: compactPreTokensOf(record),
    requestId: type === "api-request" ? nonEmptyText(record.id) : null,
    querySource: type === "api-request" ? nonEmptyText(record.querySource) : null,
    requestRef: nonEmptyText(record.requestRef),
    askAnswers: askAnswersOf(record.toolUseResult),
  };
}

function compactPreTokensOf(record: Record<string, unknown>): number | null {
  return tokenCount(asRecord(record.compactMetadata)?.preTokens);
}

function askAnswersOf(value: unknown): Record<string, string> | null {
  const answers = asRecord(asRecord(value)?.answers);
  if (answers === null) return null;
  const result: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer === "string") result[question] = answer;
  }
  return result;
}

function usageOf(message: Record<string, unknown>): TranscriptUsage | null {
  const usage = asRecord(message.usage);
  if (usage === null) return null;
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  if (cacheWrite === null || cacheRead === null) return null;
  const creation = asRecord(usage.cache_creation);
  return {
    cacheWrite,
    cacheRead,
    cacheWrite1h: creation === null ? null : tokenCount(creation.ephemeral_1h_input_tokens),
    cacheWrite5m: creation === null ? null : tokenCount(creation.ephemeral_5m_input_tokens),
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// 分岐（`/rewind` や resume）で古い枝を混ぜない。
// サブエージェントの記録（isSidechain）は本流ではないので、葉にも起点にもしない。
// 圧縮の境界で枝が切れるので、待ち・段階・キャッシュはこの枝だけで判定する。
// 会話を出すときは conversationBranch を使う。
export function activeBranch(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return walkBranch(entries, false);
}

// 会話に出す枝。圧縮の境界は parentUuid を持たず、圧縮前の葉を logicalParentUuid にだけ
// 残す。ここでその 1 本を辿り直して、圧縮の前後を 1 本の枝として扱う。辿ると、境界の
// 要約も普通の行として混ざるので、射影の側で isCompactSummary を外す。
export function conversationBranch(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return walkBranch(entries, true);
}

function walkBranch(
  entries: readonly TranscriptEntry[],
  crossCompaction: boolean,
): TranscriptEntry[] {
  const byUuid = new Map<string, TranscriptEntry>();
  let leaf: TranscriptEntry | undefined;
  for (const entry of entries) {
    if (entry.uuid === null) continue;
    byUuid.set(entry.uuid, entry);
    if (!entry.sidechain) leaf = entry;
  }

  const branch: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current !== undefined && current.uuid !== null && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    branch.push(current);
    const parent = parentOf(current, crossCompaction);
    current = parent === null ? undefined : byUuid.get(parent);
  }
  return branch.reverse();
}

function parentOf(entry: TranscriptEntry, crossCompaction: boolean): string | null {
  if (entry.parentUuid !== null) return entry.parentUuid;
  if (!crossCompaction) return null;
  if (entry.type !== "system" || entry.subtype !== "compact_boundary") return null;
  return entry.logicalParentUuid;
}

// Claude Code は貼り付けた入力を `<pasted_content id="…">…</pasted_content id="…">` で
// 包んで transcript に残す。hwc は Herdr の paste 経路で送るため、改行を含む本文（添付の
// 注記を含むものを含む）は包まれる。hwc の本文ではないので取り込み時に外す。開きと閉じの
// id が揃った組だけを外し、片側だけ・id の違う組は本文として残す（外部形式を推測で削らない）。
const PASTED_CONTENT =
  /<pasted_content id="([^"\n]{1,64})">\n?([\s\S]*?)\n?<\/pasted_content id="([^"\n]{1,64})">/g;

export function stripPastedContent(text: string): string {
  let unwrapped = false;
  const body = text.replace(PASTED_CONTENT, (match, open: string, inner: string, close: string) => {
    if (open !== close) return match;
    unwrapped = true;
    return inner;
  });
  if (!unwrapped) return text;
  // 包みの外側に付く空行は Claude Code が足したもの。本文の前後の改行だけを落とす。
  return body.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function isLocalCommandEcho(text: string): boolean {
  const head = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => head.startsWith(tag));
}

// user の本文は文字列のことが多い。配列のときは text ブロックだけを拾い、tool_result だけの
// entry はメッセージにしない。画像は v1 では出さないので、画像だけの entry も空になる。
export function userText(content: TranscriptContent | undefined): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "text" || block.text === undefined || block.text === "") continue;
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

export function assistantText(content: TranscriptContent | undefined): string {
  if (content === null || content === undefined || typeof content === "string") return "";
  let text = "";
  for (const block of content) {
    if (block.type !== "text" || block.text === undefined) continue;
    text += block.text;
  }
  return text;
}

export function blocksOf(content: TranscriptContent | undefined): TranscriptBlock[] {
  return Array.isArray(content) ? content : [];
}

function projectContent(content: unknown): TranscriptContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks: TranscriptBlock[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block === null) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") blocks.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string") {
          blocks.push({ type: "thinking", thinking: block.thinking });
        }
        break;
      case "tool_use":
        blocks.push({
          type: "tool_use",
          ...(typeof block.id === "string" ? { id: block.id } : {}),
          ...(typeof block.name === "string" ? { name: block.name } : {}),
          ...(block.input === undefined ? {} : { input: block.input }),
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          ...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}),
          ...(block.is_error === true ? { isError: true } : {}),
        });
        break;
      case "image":
        blocks.push({ type: "image" });
        break;
    }
  }
  return blocks;
}

function timestampOf(value: unknown): number {
  if (typeof value !== "string") return 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}
