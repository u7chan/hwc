import { createHash } from "node:crypto";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ATTACHED_FILES_CLOSE,
  ATTACHED_FILES_OPEN,
  stripAttachedFiles,
} from "../../shared/attachments";
import { ASK_USER_QUESTION, questionPending, toolPending, toolSummary } from "./claude-pending";
import { readSidecar, SESSION_ID, SIDECAR_TTL_MS } from "./claude-sidecar";
import type { ChatMessage, ChatPending, ChatSnapshot, SessionChatClient } from "./contract";
import { ChatUnavailableError } from "./errors";
import { limitMessages } from "./limit";

// transcript は追記され続ける。16MB を超えるセッションは末尾だけを読み、先頭を切ったことを
// truncated で知らせる。増分読みは、大きなセッションで表示が重いと分かってから別 Issue で足す。
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

// poll のたびに projects/* を readdir しない。見つからなかった id は短くだけ覚える。
const MISSING_TTL_MS = 30_000;

// 追記が止まったセッションを開き直したときに、同じファイルを読み直さない。
const MAX_PROJECTIONS = 8;

// TUI のローカルコマンド（`/model` や `/theme`）の記録は利用者の発話ではない。会話に混ぜると
// 会話の流れがコマンドの結果で埋まる。
const LOCAL_COMMAND_TAGS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

// 利用者が Esc で中断したときに CLI が user の本文として書く固定の記録。発話ではない。
// 質問に答えるときは hwc が Esc を送るので、毎回これが残る（ADR 0099）。
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

// API を呼ばずに失敗したターンの記録に付くモデル名。表示するモデルではない。
const SYNTHETIC_MODEL = "<synthetic>";

type TranscriptEntry = {
  type: string;
  uuid: string;
  parentUuid: string | null;
  at: number;
  sidechain: boolean;
  meta: boolean;
  compactSummary: boolean;
  apiError: boolean;
  error: string | null;
  effort: string | null;
  message: { id: string | null; model: string | null; content: unknown } | null;
};

// resolved は active branch で tool_result が書かれた tool_use の id。transcript と一緒に
// 読み、sidecar の待ちがもう解決済みかの判定に使う。
type Projection = {
  size: number;
  inode: number;
  snapshot: ChatSnapshot;
  resolved: ReadonlySet<string>;
};

type AssistantGroup = { id: string; at: number; text: string; error: string | null };

type PendingTool = { id: string; name: string; input: unknown };

export function createClaudeChatClient(
  options: {
    maxBytes?: number;
    now?: () => number;
    // hook が応答待ちを書く場所。無ければ transcript の末尾の tool_use だけを見る。
    pendingRoot?: string;
  } = {},
): SessionChatClient {
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const now = options.now ?? Date.now;
  const locations = new Map<string, { path: string } | { missingUntil: number }>();
  const projections = new Map<string, Projection>();
  const running = new Map<string, Promise<ChatSnapshot>>();

  // 見つかった path は、CLAUDE_CONFIG_DIR を含めた組で覚える。unit や E2E が root を
  // 差し替えたときに、別の root の結果を引き継がないため。
  const locate = async (root: string, sessionId: string, key: string): Promise<string> => {
    const cached = locations.get(key);
    if (cached !== undefined) {
      if ("path" in cached) return cached.path;
      if (cached.missingUntil > now()) {
        throw new ChatUnavailableError("claude session was not found");
      }
      locations.delete(key);
    }

    const path = await findTranscript(root, sessionId);
    if (path === null) {
      locations.set(key, { missingUntil: now() + MISSING_TTL_MS });
      throw new ChatUnavailableError("claude session was not found");
    }
    locations.set(key, { path });
    return path;
  };

  const project = async (path: string, sessionId: string): Promise<Projection> => {
    const known = projections.get(path);
    if (known !== undefined) {
      const info = await stat(path).catch(() => null);
      if (info !== null && info.isFile() && info.size === known.size && info.ino === known.inode) {
        return known;
      }
    }

    const transcript = await readTranscript(path, maxBytes);
    const projection = {
      size: transcript.size,
      inode: transcript.inode,
      ...snapshotOf(sessionId, transcript.entries, transcript.clipped),
    };
    projections.set(path, projection);
    if (projections.size > MAX_PROJECTIONS) {
      const oldest = projections.keys().next().value;
      if (oldest !== undefined) projections.delete(oldest);
    }
    return projection;
  };

  const load = async (sessionId: string): Promise<ChatSnapshot> => {
    if (!SESSION_ID.test(sessionId)) {
      throw new ChatUnavailableError("claude session id is invalid");
    }
    const root = configRoot();
    const key = `${root}\u0000${sessionId}`;
    const path = await locate(root, sessionId, key);
    try {
      const { snapshot, resolved } = await project(path, sessionId);
      return await withHookPending(snapshot, resolved, sessionId);
    } catch (error) {
      // 消えた transcript は覚えない。次に現れたときに読み直す。
      if (error instanceof ChatUnavailableError) locations.delete(key);
      throw error;
    }
  };

  // hook の sidecar は transcript の外にあるので、transcript の射影のキャッシュとは別に毎回読む。
  // Esc で閉じた待ちは hook が何も呼ばないので、tool_result が書かれたかで解決を知る。
  const withHookPending = async (
    snapshot: ChatSnapshot,
    resolved: ReadonlySet<string>,
    sessionId: string,
  ): Promise<ChatSnapshot> => {
    if (options.pendingRoot === undefined) return snapshot;
    const sidecar = await readSidecar(options.pendingRoot, sessionId);
    const pending = sidecar?.pending ?? null;
    if (pending === null || sidecar === null) return snapshot;
    if (now() - sidecar.at > SIDECAR_TTL_MS || resolved.has(pending.toolUseId)) return snapshot;
    const { etag: _etag, ...body } = snapshot;
    return { ...body, pending, etag: etagOf(sessionId, { ...body, pending }) };
  };

  return {
    snapshot(sessionId) {
      const pending = running.get(sessionId);
      if (pending) return pending;
      const settled = load(sessionId).finally(() => {
        if (running.get(sessionId) === settled) running.delete(sessionId);
      });
      running.set(sessionId, settled);
      return settled;
    },
  };
}

// Claude Code は設定ディレクトリ配下の projects/<cwd のエンコード>/<session uuid>.jsonl に
// transcript を書く。プロジェクト名は内部形式なので、id で総当たりする。
async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const projects = join(root, "projects");
  let directories;
  try {
    directories = await readdir(projects, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const candidate = join(projects, directory.name, `${sessionId}.jsonl`);
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile() === true) matches.push(candidate);
  }

  // 同じ id が複数のプロジェクトにあると、どれが会話か決められない。推測しない。
  if (matches.length > 1) throw new ChatUnavailableError("claude session is ambiguous");
  return matches[0] ?? null;
}

function configRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && isAbsolute(configured)) return configured;
  return join(homedir(), ".claude");
}

async function readTranscript(
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

function parseTranscript(
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
    const entry = toEntry(record);
    if (entry !== null) entries.push(entry);
  }

  // 1 行も解釈できないファイルは transcript ではない。空として扱うと、会話が消えた理由が
  // 画面から分からなくなる。
  if (objects === 0 && first === 0 && raw.trim() !== "") {
    throw new ChatUnavailableError("claude transcript is unreadable");
  }
  return { entries, clipped };
}

function toEntry(record: Record<string, unknown>): TranscriptEntry | null {
  const type = record.type;
  const uuid = record.uuid;
  if (typeof type !== "string" || typeof uuid !== "string" || uuid === "") return null;
  const message = asRecord(record.message);
  return {
    type,
    uuid,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
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
            content: message.content,
          },
  };
}

function snapshotOf(
  sessionId: string,
  entries: readonly TranscriptEntry[],
  clipped: boolean,
): { snapshot: ChatSnapshot; resolved: ReadonlySet<string> } {
  const branch = activeBranch(entries);
  const resolved = resolvedToolUseIds(branch);
  let model: string | null = null;
  let effort: string | null = null;
  for (const entry of branch) {
    if (entry.type !== "assistant" || entry.sidechain) continue;
    const entryModel = entry.message?.model ?? null;
    if (entryModel !== null && entryModel !== SYNTHETIC_MODEL) model = entryModel;
    if (entry.effort !== null) effort = entry.effort;
  }

  const limited = limitMessages(projectMessages(branch));
  const pending = projectPending(branch, resolved);
  const body: Omit<ChatSnapshot, "etag"> = {
    messages: limited.messages,
    model,
    effort,
    truncated: clipped || limited.truncated,
    // 読み取り API はコンテキスト量と圧縮の形を返さない。どちらも別 Issue で足す。
    context: null,
    compaction: null,
    ...(pending === null ? {} : { pending }),
  };
  return { snapshot: { ...body, etag: etagOf(sessionId, body) }, resolved };
}

function etagOf(sessionId: string, body: Omit<ChatSnapshot, "etag">): string {
  return createHash("sha256").update(sessionId).update(JSON.stringify(body)).digest("hex");
}

// 分岐（`/rewind` や resume）で古い枝を混ぜない。最後の entry から parentUuid を辿る。
// サブエージェントの記録（isSidechain）は本流ではないので、葉にも起点にもしない。
function activeBranch(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
  let leaf = entries.length - 1;
  while (leaf >= 0 && entries[leaf]?.sidechain === true) leaf -= 1;

  const branch: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = entries[leaf];
  while (current !== undefined && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    branch.push(current);
    current = current.parentUuid === null ? undefined : byUuid.get(current.parentUuid);
  }
  return branch.reverse();
}

// 未解決の tool_use を拾う。突き合わせのキーは tool_use block の id と tool_result の
// tool_use_id。entry の uuid は、どの entry の tool_use かを辿るためにだけ使う
// （assistant は block ごとに別 entry なので、message.id では tool_use を区別できない）。
function projectPending(
  branch: readonly TranscriptEntry[],
  resolved: ReadonlySet<string>,
): ChatPending | null {
  const tools: PendingTool[] = [];
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "assistant") continue;
    tools.push(...toolUses(entry.message?.content));
  }

  // 会話の末尾が assistant の tool_use のときだけ。tool_result が書かれたら消える。
  // 行にならない entry（isMeta など）は末尾として見ない。
  const tail = lastConversationEntry(branch);
  if (tail === null || tail.type !== "assistant") return null;
  const tailIds = new Set(toolUses(tail.message?.content).map((tool) => tool.id));
  const unresolved = tools.filter((tool) => !resolved.has(tool.id));
  if (!unresolved.some((tool) => tailIds.has(tool.id))) return null;

  // 承認待ちが複数あるとき、どれが人間待ちか transcript だけでは決められない。
  // AskUserQuestion を優先し、無ければ最後の 1 件を代表にする。
  let question: PendingTool | null = null;
  for (const tool of unresolved) {
    if (tool.name === ASK_USER_QUESTION) question = tool;
  }
  if (question !== null) return questionPending(question.id, question.input);

  const last = unresolved[unresolved.length - 1];
  if (last === undefined) return null;
  return toolPending(last.id, last.name, toolSummary(last.name, last.input));
}

function resolvedToolUseIds(branch: readonly TranscriptEntry[]): Set<string> {
  const resolved = new Set<string>();
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "user") continue;
    for (const id of toolResultIds(entry.message?.content)) resolved.add(id);
  }
  return resolved;
}

function lastConversationEntry(branch: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === undefined || entry.sidechain || entry.meta || entry.compactSummary) continue;
    if (entry.type === "user" || entry.type === "assistant") return entry;
  }
  return null;
}

function toolResultIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    ids.push(block.tool_use_id);
  }
  return ids;
}

function toolUses(content: unknown): PendingTool[] {
  if (!Array.isArray(content)) return [];
  const tools: PendingTool[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== "tool_use" || typeof block.id !== "string" || block.id === "") continue;
    if (typeof block.name !== "string" || block.name === "") continue;
    tools.push({ id: block.id, name: block.name, input: block.input });
  }
  return tools;
}

function projectMessages(branch: readonly TranscriptEntry[]): ChatMessage[] {
  // Claude は 1 つの API メッセージを block ごとに複数の entry へ分けて書く。text を
  // ファイル順に連結して 1 行にする。id は最初の entry の uuid で、message.id は使わない
  // （同じ組の複数 entry が同じ id になり、クライアントの key が衝突する）。
  const groups = new Map<string, AssistantGroup>();
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "assistant") continue;
    const key = groupKey(entry);
    const text = assistantText(entry.message?.content);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        id: entry.uuid,
        at: entry.at,
        text,
        error: entry.apiError ? entry.error : null,
      });
      continue;
    }
    group.text += text;
    if (entry.apiError && entry.error !== null) group.error = entry.error;
  }

  const messages: ChatMessage[] = [];
  const emitted = new Set<string>();
  for (const entry of branch) {
    if (entry.sidechain) continue;
    if (entry.type === "user") {
      const message = projectUser(entry);
      if (message !== null) messages.push(message);
      continue;
    }
    if (entry.type !== "assistant") continue;
    const key = groupKey(entry);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const group = groups.get(key);
    if (group === undefined) continue;
    // 失敗したターンは本文が無くても行にする。本文が空だと、送ったのに何も返らないまま
    // idle に戻り、送信が届いていないように見える（ADR 0039）。
    const text =
      group.error === null
        ? group.text
        : [group.error, group.text].filter((part) => part !== "").join("\n");
    if (text.trim() === "") continue;
    messages.push({
      id: group.id,
      role: group.error === null ? "agent" : "error",
      text,
      at: group.at,
    });
  }
  return messages;
}

function groupKey(entry: TranscriptEntry): string {
  const id = entry.message?.id;
  return id ?? `uuid\u0000${entry.uuid}`;
}

function projectUser(entry: TranscriptEntry): ChatMessage | null {
  // isMeta は hwc の画面に出ないシステム寄りの記録。圧縮の要約は本文ではないので、
  // 区切りと要約の扱いを決めるまで出さない。
  // TBD: 圧縮済みセッションの形（isCompactSummary / compact_boundary）が実物で確認できるまで。
  if (entry.meta || entry.compactSummary) return null;
  const raw = userText(entry.message?.content);
  if (raw === "") return null;
  if (isLocalCommandEcho(raw)) return null;
  if (INTERRUPT_MARKERS.has(raw.trim())) return null;

  const { text, attachments } = projectUserText(raw);
  if (text === "" && attachments.length === 0) return null;
  return {
    id: entry.uuid,
    role: "user",
    text,
    at: entry.at,
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.map((name) => ({ name, size: null })) }),
  };
}

// 注記の書式が崩れていて名前を取り出せないときは、注記ブロックごと落とす。hwc の保存先は
// 絶対パスなので、本文に残すと画面へパスを出してしまう。
function projectUserText(raw: string): { text: string; attachments: string[] } {
  let text = raw;
  for (;;) {
    const stripped = stripAttachedFiles(text);
    if (stripped.attachments.length > 0 || !stripped.text.includes(ATTACHED_FILES_OPEN)) {
      return stripped;
    }
    const openAt = stripped.text.lastIndexOf(ATTACHED_FILES_OPEN);
    const closeAt = stripped.text.indexOf(
      ATTACHED_FILES_CLOSE,
      openAt + ATTACHED_FILES_OPEN.length,
    );
    const end = closeAt < 0 ? stripped.text.length : closeAt + ATTACHED_FILES_CLOSE.length;
    text = `${stripped.text.slice(0, openAt)}${stripped.text.slice(end)}`
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function isLocalCommandEcho(text: string): boolean {
  const head = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => head.startsWith(tag));
}

// user の本文は文字列のことが多い。配列のときは text ブロックだけを拾い、tool_result だけの
// entry はメッセージにしない。画像は v1 では出さないので、画像だけの entry も空になる。
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (block.text === "") continue;
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    text += block.text;
  }
  return text;
}

function timestampOf(value: unknown): number {
  if (typeof value !== "string") return 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
