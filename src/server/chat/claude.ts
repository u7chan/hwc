import { createHash } from "node:crypto";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { ACTIVITY_RATE_PHASES, TOOL_NAME_LIMIT, TOOLS_LIMIT } from "../../shared/activity";
import {
  ATTACHED_FILES_CLOSE,
  ATTACHED_FILES_OPEN,
  stripAttachedFiles,
} from "../../shared/attachments";
import { ASK_USER_QUESTION, questionPending, toolPending, toolSummary } from "./claude-pending";
import { readLive } from "./claude-live";
import { readSidecar, SESSION_ID, SIDECAR_TTL_MS } from "./claude-sidecar";
import type {
  ChatMessage,
  ChatPending,
  ChatSnapshot,
  SessionActivity,
  SessionChatClient,
} from "./contract";
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

// api-request / tool_use の ID で応答の有無を判定できる版（ADR 0097 / 0100）。
const MIN_ACTIVITY_VERSION = [2, 1, 327] as const;

// 帯の 2 行は activitySnippet の 160 文字に収める。対象 60 + 改行 + 方向 90。
const TARGET_LIMIT = 60;
const DIRECTION_LIMIT = 90;

// メインスレッドの要求だけが会話の応答を待つ。sdk の要求は本流の段階ではない。
const MAIN_THREAD_SOURCE = "repl_main_thread";

// transcript の message.content を、会話と段階に使う種類だけに絞った形。tool_result の
// 本文や画像の base64 は抱えない（大きなセッションでも射影を膨らませないため）。
type TranscriptBlock = {
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

type TranscriptContent = string | TranscriptBlock[] | null;

type TranscriptEntry = {
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
  message: { id: string | null; model: string | null; content: TranscriptContent } | null;
  // 要求と応答の対応。api-request の id と assistant の requestRef が一致する。
  requestId: string | null;
  querySource: string | null;
  requestRef: string | null;
};

// resolved は active branch で tool_result が書かれた tool_use の id。transcript と一緒に
// 読み、sidecar の待ちがもう解決済みかの判定に使う。
type Projection = {
  size: number;
  inode: number;
  snapshot: ChatSnapshot;
  resolved: ReadonlySet<string>;
  entries: TranscriptEntry[];
};

type AssistantGroup = { id: string; at: number; text: string; error: string | null };

type PendingTool = { id: string; name: string; input: unknown };

type ToolUse = {
  id: string | null;
  name: string;
  input: unknown;
  version: string | null;
  index: number;
};

type ToolResult = { toolUseId: string | null; index: number };
type RequestRef = { id: string | null; version: string | null; index: number };
type AnswerRef = { requestRef: string | null; apiError: boolean; index: number };

export function createClaudeChatClient(
  options: {
    maxBytes?: number;
    now?: () => number;
    // hook が応答待ちを書く場所。無ければ transcript の末尾の tool_use だけを見る。
    pendingRoot?: string;
    // mod が生成中の速度を書く場所。無ければ帯に速度を出さない。
    liveRoot?: string;
  } = {},
): SessionChatClient & {
  activity: (sessionId: string) => Promise<SessionActivity>;
} {
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const now = options.now ?? Date.now;
  const locations = new Map<string, { path: string } | { missingUntil: number }>();
  const projections = new Map<string, Projection>();
  const running = new Map<string, Promise<Projection>>();

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
      entries: transcript.entries,
    };
    projections.set(path, projection);
    if (projections.size > MAX_PROJECTIONS) {
      const oldest = projections.keys().next().value;
      if (oldest !== undefined) projections.delete(oldest);
    }
    return projection;
  };

  const load = async (sessionId: string): Promise<Projection> => {
    if (!SESSION_ID.test(sessionId)) {
      throw new ChatUnavailableError("claude session id is invalid");
    }
    const root = configRoot();
    const key = `${root}\u0000${sessionId}`;
    const path = await locate(root, sessionId, key);
    try {
      return await project(path, sessionId);
    } catch (error) {
      // 消えた transcript は覚えない。次に現れたときに読み直す。
      if (error instanceof ChatUnavailableError) locations.delete(key);
      throw error;
    }
  };

  // 会話と段階は同じ読み取りに相乗りする。ターン中の追記は、行が増えたときだけ読み直す。
  const shared = (sessionId: string): Promise<Projection> => {
    const pending = running.get(sessionId);
    if (pending) return pending;
    const settled = load(sessionId).finally(() => {
      if (running.get(sessionId) === settled) running.delete(sessionId);
    });
    running.set(sessionId, settled);
    return settled;
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
    async snapshot(sessionId) {
      const projection = await shared(sessionId);
      return withHookPending(projection.snapshot, projection.resolved, sessionId);
    },
    async activity(sessionId) {
      const at = now();
      const derived = sessionActivityOf((await shared(sessionId)).entries, at);
      const activity = derived.activity;
      if (activity === null || options.liveRoot === undefined) return derived;
      // 速度は生成中の phase だけ。tool の待ちに前の応答の速度を残さない。
      if (!(ACTIVITY_RATE_PHASES as readonly string[]).includes(activity.phase)) return derived;
      const live = await readLive(options.liveRoot, sessionId, at);
      if (live?.tokPerSecond == null) return derived;
      return { ...derived, activity: { ...activity, tokPerSecond: live.tokPerSecond } };
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
          },
    requestId: type === "api-request" ? nonEmptyText(record.id) : null,
    querySource: type === "api-request" ? nonEmptyText(record.querySource) : null,
    requestRef: nonEmptyText(record.requestRef),
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

function toolResultIds(content: TranscriptContent | undefined): string[] {
  const ids: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_result" || block.toolUseId === undefined) continue;
    ids.push(block.toolUseId);
  }
  return ids;
}

function toolUses(content: TranscriptContent | undefined): PendingTool[] {
  const tools: PendingTool[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_use" || block.id === undefined || block.id === "") continue;
    if (block.name === undefined || block.name === "") continue;
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
        id: entry.uuid ?? key,
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
  return id ?? `uuid\u0000${entry.uuid ?? String(entry.index)}`;
}

function projectUser(entry: TranscriptEntry): ChatMessage | null {
  // isMeta は hwc の画面に出ないシステム寄りの記録。圧縮の要約は本文ではないので、
  // 区切りと要約の扱いを決めるまで出さない。
  // TBD: 圧縮済みセッションの形（isCompactSummary / compact_boundary）が実物で確認できるまで。
  if (entry.meta || entry.compactSummary) return null;
  const raw = userText(entry.message?.content);
  if (raw === "") return null;
  // Claude Code が付ける貼り付けの包みを先に外す。添付の注記は包みの中にあり、
  // 注記を剥がしてからでは閉じタグが消えて組を取れない。
  const body = stripPastedContent(raw);
  if (isLocalCommandEcho(body)) return null;
  if (INTERRUPT_MARKERS.has(body.trim())) return null;

  const { text, attachments } = projectUserText(body);
  if (text === "" && attachments.length === 0) return null;
  return {
    id: entry.uuid ?? "",
    role: "user",
    text,
    at: entry.at,
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.map((name) => ({ name, size: null })) }),
  };
}

// Claude Code は貼り付けた入力を `<pasted_content id="…">…</pasted_content id="…">` で
// 包んで transcript に残す。hwc は Herdr の paste 経路で送るため、改行を含む本文（添付の
// 注記を含むものを含む）は包まれる。hwc の本文ではないので取り込み時に外す。開きと閉じの
// id が揃った組だけを外し、片側だけ・id の違う組は本文として残す（外部形式を推測で削らない）。
const PASTED_CONTENT =
  /<pasted_content id="([^"\n]{1,64})">\n?([\s\S]*?)\n?<\/pasted_content id="([^"\n]{1,64})">/g;

function stripPastedContent(text: string): string {
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
function userText(content: TranscriptContent | undefined): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "text" || block.text === undefined || block.text === "") continue;
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

function assistantText(content: TranscriptContent | undefined): string {
  if (content === null || content === undefined || typeof content === "string") return "";
  let text = "";
  for (const block of content) {
    if (block.type !== "text" || block.text === undefined) continue;
    text += block.text;
  }
  return text;
}

// ターンの起点と、そこから読める段階（ADR 0100）。段階に使う行は枝で絞らず、ファイル順に
// 起点より後ろを全部見る。並列ツールの tool_use は一時的に親鎖の外へ出るため。
function sessionActivityOf(entries: readonly TranscriptEntry[], now: number): SessionActivity {
  const branch = activeBranch(entries);
  const start = lastPrompt(branch);
  if (start === undefined || start.uuid === null) return { prompt: null, activity: null };
  const prompt = start.uuid;

  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];
  const requests: RequestRef[] = [];
  const answers: AnswerRef[] = [];
  for (const entry of entries) {
    if (entry.index <= start.index || entry.sidechain) continue;
    if (entry.type === "api-request") {
      // サブエージェント（sdk）の要求は本流の段階ではない。
      if (entry.querySource === MAIN_THREAD_SOURCE) {
        requests.push({ id: entry.requestId, version: entry.version, index: entry.index });
      }
      continue;
    }
    if (entry.type === "assistant") {
      answers.push({ requestRef: entry.requestRef, apiError: entry.apiError, index: entry.index });
      for (const block of blocksOf(entry.message?.content)) {
        if (block.type !== "tool_use") continue;
        toolUses.push({
          id: nonEmptyText(block.id),
          name: nonEmptyText(block.name) ?? "",
          input: block.input,
          version: entry.version,
          index: entry.index,
        });
      }
      continue;
    }
    if (entry.type !== "user") continue;
    for (const block of blocksOf(entry.message?.content)) {
      if (block.type !== "tool_result") continue;
      toolResults.push({ toolUseId: nonEmptyText(block.toolUseId), index: entry.index });
    }
  }

  const direction = directionOf(branch, start.index);
  const finished = new Set(
    toolResults.flatMap((result) => (result.toolUseId === null ? [] : [result.toolUseId])),
  );
  const unfinished = toolUses.filter((tool) => tool.id === null || !finished.has(tool.id));

  if (unfinished.length > 0) {
    for (const tool of unfinished) {
      // ID が無い・版が古い・結果側に ID が無い形式では、終わったかを決められない。
      if (tool.id === null) return { prompt, activity: null };
      if (!versionAtLeast(tool.version)) return { prompt, activity: null };
      if (toolResults.some((result) => result.toolUseId === null && result.index > tool.index)) {
        return { prompt, activity: null };
      }
    }
    const representative = unfinished[unfinished.length - 1]!;
    return {
      prompt,
      activity: {
        phase: "tool",
        text: joinLines(toolTarget(representative), direction),
        tool: toolNameOf(representative),
        tools: Math.min(unfinished.length, TOOLS_LIMIT),
        tokPerSecond: null,
        at: now,
      },
    };
  }

  const request = requests[requests.length - 1];
  if (request !== undefined) {
    const answered =
      request.id !== null &&
      answers.some((answer) => answer.requestRef === request.id && answer.index > request.index);
    // 失敗の行は requestRef を持たないが、その要求が終わったことは示す。
    const failed = answers.some((answer) => answer.apiError && answer.index > request.index);
    if (!answered && !failed) {
      // requestRef を持たない assistant は、どの要求の応答か決められない。
      if (
        answers.some(
          (answer) =>
            !answer.apiError && answer.requestRef === null && answer.index > request.index,
        )
      ) {
        return { prompt, activity: null };
      }
      if (request.id === null) return { prompt, activity: null };
      if (!versionAtLeast(request.version)) return { prompt, activity: null };
      return {
        prompt,
        activity: {
          phase: "thinking",
          text: direction,
          tool: null,
          tools: 1,
          tokPerSecond: null,
          at: now,
        },
      };
    }
  }

  return { prompt, activity: null };
}

// ターンの起点は active branch にある最後の prompt。画像だけの発言も起点になる。
function lastPrompt(branch: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (isPrompt(entry)) return entry;
  }
  return undefined;
}

function isPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.sidechain || entry.meta || entry.compactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text !== "" && !isLocalCommandEcho(text) && !INTERRUPT_MARKERS.has(text);
  }
  if (content === null || content === undefined) return false;
  for (const block of content) {
    if (block.type === "image") return true;
    if (block.type !== "text" || block.text === undefined) continue;
    const text = block.text.trim();
    if (text !== "" && !isLocalCommandEcho(text) && !INTERRUPT_MARKERS.has(text)) return true;
  }
  return false;
}

// 方向は、起点より後ろの枝にある最後の assistant の text の先頭 1 行。無ければ thinking の
// 本文の末尾。thinking は要約のことも生の本文のこともあるが、transcript に載った文を使う。
function directionOf(branch: readonly TranscriptEntry[], startIndex: number): string {
  let text = "";
  let thinking = "";
  for (const entry of branch) {
    if (entry.index <= startIndex || entry.sidechain || entry.type !== "assistant") continue;
    if (entry.apiError) continue;
    for (const block of blocksOf(entry.message?.content)) {
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        text = block.text;
      } else if (
        block.type === "thinking" &&
        block.thinking !== undefined &&
        block.thinking.trim() !== ""
      ) {
        thinking = block.thinking;
      }
    }
  }
  if (text !== "") return headLine(text, DIRECTION_LIMIT);
  if (thinking !== "") return tailLine(thinking, DIRECTION_LIMIT);
  return "";
}

// ツールの対象。コマンドの本文は会話の内容そのものなので出さない。
function toolTarget(tool: ToolUse): string {
  const input = asRecord(tool.input);
  if (input === null) return "";
  const field = (key: string): string => nonEmptyText(input[key]) ?? "";
  let target = "";
  switch (tool.name.toLowerCase()) {
    case "bash":
    case "task":
      target = field("description");
      break;
    case "read":
    case "edit":
    case "write":
    case "grep":
    case "glob": {
      const path = field("file_path");
      target = path === "" ? "" : basename(path);
      break;
    }
  }
  // 改行と制御文字は 1 行に畳む。対象は先頭から 60 文字まで。
  return sliceHead(flatten(target), TARGET_LIMIT);
}

function toolNameOf(tool: ToolUse): string | null {
  return tool.name === "" ? null : sliceHead(tool.name, TOOL_NAME_LIMIT);
}

function joinLines(target: string, direction: string): string {
  if (target === "") return direction;
  if (direction === "") return target;
  return `${target}\n${direction}`;
}

function headLine(raw: string, limit: number): string {
  for (const line of raw.split(/\r?\n/)) {
    const text = flatten(line);
    if (text !== "") return sliceHead(text, limit);
  }
  return "";
}

function tailLine(raw: string, limit: number): string {
  return Array.from(flatten(raw)).slice(-limit).join("");
}

function sliceHead(raw: string, limit: number): string {
  return Array.from(raw).slice(0, limit).join("");
}

function flatten(raw: string): string {
  return raw
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

function versionAtLeast(version: string | null): boolean {
  if (version === null) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MIN_ACTIVITY_VERSION.length; index += 1) {
    const mine = parts[index]!;
    const minimum = MIN_ACTIVITY_VERSION[index]!;
    if (mine !== minimum) return mine > minimum;
  }
  return true;
}

function blocksOf(content: TranscriptContent | undefined): TranscriptBlock[] {
  return Array.isArray(content) ? content : [];
}

// 会話と段階に使う種類だけを残す。tool_result の本文や画像の base64 は、射影を抱えたまま
// 大きくならないよう落とす。
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
