import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatContext, ChatMessage, ChatSnapshot } from "./contract";

// 直近の会話だけを返す。古い側は端末出力で読める。
const MAX_MESSAGES = 500;
const MAX_BYTES = 1024 * 1024;

// 40MB のセッションを一度に読まないよう、追記分はチャンクに分けて読む。
const CHUNK_BYTES = 1024 * 1024;

// ヘッダ行だけは毎回読む。1 行がこれより長いセッションは想定しない。
const HEADER_PROBE_BYTES = 128 * 1024;

const CURRENT_VERSION = 3;

const MODELS_STORE = "models-store.json";
const MODELS_CONFIG = "models.json";

export class ChatUnavailableError extends Error {}

export type ChatClient = {
  snapshot: (sessionPath: string) => Promise<ChatSnapshot>;
};

// (provider, model) から contextWindow を引く。プロセス内で固定のカタログとして扱う。
export type ModelCatalog = {
  contextWindow: (provider: string | null, model: string | null) => number | null;
};

type WindowResolver = (
  sessionPath: string,
  provider: string | null,
  model: string | null,
) => Promise<number | null>;

type SessionEntry = {
  id: string;
  parentId: string | null;
  message: ChatMessage | null;
  model: string | null;
  provider: string | null;
  effort: string | null;
  usageTokens: number | null;
  invalidatesUsage: boolean;
};

export type ChatReader = {
  path: string;
  offset: number;
  pending: Uint8Array;
  entries: Map<string, SessionEntry>;
  leafId: string | null;
  headerId: string | null;
  inode: number | null;
  generation: number;
  etagPrefix: string;
};

function createReader(path: string): ChatReader {
  return {
    path,
    offset: 0,
    pending: new Uint8Array(0),
    entries: new Map(),
    leafId: null,
    headerId: null,
    inode: null,
    generation: 0,
    // path のハッシュだけでなく、BFF の起動ごとに変わる id を混ぜる。
    // 再起動後に古い ETag と一致させないため。
    etagPrefix: `${hashPath(path)}-${randomUUID()}`,
  };
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function createChatClient(
  options: {
    limit?: number;
    load?: (reader: ChatReader) => Promise<ChatSnapshot>;
    sessionAgentDir?: (sessionPath: string) => Promise<string | null>;
    loadCatalog?: (agentDir: string) => Promise<ModelCatalog>;
  } = {},
): ChatClient {
  const limit = options.limit ?? 8;
  const windowFor = createWindowResolver(
    options.sessionAgentDir ?? sessionAgentDirOf,
    options.loadCatalog ?? loadCatalogFrom,
  );
  const load = options.load ?? ((reader: ChatReader) => readSessionFile(reader, windowFor));
  const readers = new Map<string, ChatReader>();
  const running = new Map<string, Promise<ChatSnapshot>>();

  // path ごとに上限を設け、触ったものを末尾へ移す。溢れたら最も古いものから捨てる。
  const readerFor = (path: string): ChatReader => {
    const cached = readers.get(path);
    if (cached) {
      readers.delete(path);
      readers.set(path, cached);
      return cached;
    }
    const reader = createReader(path);
    readers.set(path, reader);
    if (readers.size > limit) {
      const oldest = readers.keys().next().value;
      if (oldest !== undefined) readers.delete(oldest);
    }
    return reader;
  };

  return {
    snapshot(path) {
      // 追記の途中で複数の要求が重なると、同じ範囲を何度も読むことになる。1 回に畳む。
      const inFlight = running.get(path);
      if (inFlight) return inFlight;

      const settled = load(readerFor(path)).finally(() => {
        if (running.get(path) === settled) running.delete(path);
      });
      running.set(path, settled);
      return settled;
    },
  };
}

async function readSessionFile(
  reader: ChatReader,
  windowFor: WindowResolver,
): Promise<ChatSnapshot> {
  let handle: FileHandle;
  try {
    handle = await open(reader.path, "r");
  } catch (error) {
    // セッションはまだ作られていない。空の会話として扱う。
    if (!isEnoent(error)) throw error;
    forget(reader);
    return snapshotOf(reader, windowFor);
  }

  try {
    const info = await handle.stat();
    const headerId = await readHeader(handle);
    // pi は v1/v2 のセッションを開くと v3 へ rewrite する。同じ inode の truncate で
    // 前より長くなることがあるため、size と inode では書き換えを検出できない。
    // ヘッダ id は毎回読んで比べる。
    const replaced =
      (reader.headerId !== null && reader.headerId !== headerId) ||
      (reader.inode !== null && reader.inode !== info.ino) ||
      reader.offset > info.size;
    if (replaced) reset(reader);

    reader.inode = info.ino;
    reader.headerId = headerId;
    await consume(reader, handle, info.size);
    return snapshotOf(reader, windowFor);
  } finally {
    await handle.close().catch(() => {
      // 読み取りは終わっている。閉じ損ねても次の要求で開き直せる。
    });
  }
}

async function readHeader(handle: FileHandle): Promise<string> {
  const probe = Buffer.alloc(HEADER_PROBE_BYTES);
  const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
  const slice = probe.subarray(0, bytesRead);
  const newline = slice.indexOf(0x0a);
  if (newline < 0) throw new ChatUnavailableError("session header is missing");

  const header = parseHeader(slice.subarray(0, newline).toString("utf8"));
  if (!header) throw new ChatUnavailableError("session header is not an object");
  if (header.type !== "session")
    throw new ChatUnavailableError("session header type is not session");
  if (header.version !== CURRENT_VERSION) {
    throw new ChatUnavailableError(`session version ${String(header.version)} is not supported`);
  }
  if (typeof header.id !== "string" || header.id === "") {
    throw new ChatUnavailableError("session header id is missing");
  }
  return header.id;
}

function parseHeader(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

async function consume(reader: ChatReader, handle: FileHandle, size: number): Promise<void> {
  while (reader.offset < size) {
    const length = Math.min(size - reader.offset, CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, reader.offset);
    if (bytesRead === 0) return;
    reader.offset += bytesRead;
    append(reader, buffer.subarray(0, bytesRead));
  }
}

function append(reader: ChatReader, chunk: Uint8Array): void {
  const combined =
    reader.pending.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([Buffer.from(reader.pending), Buffer.from(chunk)]);
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    reader.pending = combined;
    return;
  }

  // 未完行は次回へ持ち越す。UTF-8 の途中で切れても、改行までをまとめて復号するので壊れない。
  reader.pending = combined.subarray(lastNewline + 1);
  let taken = false;
  for (const line of combined.subarray(0, lastNewline).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    taken = true;
    applyLine(reader, line);
  }
  if (taken) reader.generation += 1;
}

function applyLine(reader: ChatReader, line: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // 壊れた行だけを捨てる。ファイル全体を読めなくしない。
    return;
  }
  const record = asRecord(raw);
  if (!record) return;
  // ヘッダは木に属さない。id は持つが、エントリとして扱うと葉になってしまう。
  if (record.type === "session") return;
  // id を持たない行も木に属さない。
  if (typeof record.id !== "string" || record.id === "") return;

  const entry: SessionEntry = {
    id: record.id,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    message: null,
    model: null,
    provider: null,
    effort: null,
    usageTokens: null,
    // compaction と context_edit は、それ以前の usage を現在のコンテキスト量にしない。
    invalidatesUsage: record.type === "compaction" || record.type === "context_edit",
  };

  if (record.type === "message") {
    const message = asRecord(record.message);
    if (message) {
      const projected = project(entry.id, message, record.timestamp);
      entry.message = projected.message;
      entry.model = projected.model;
      entry.provider = projected.provider;
      entry.effort = projected.effort;
      entry.usageTokens = projected.usageTokens;
    }
  } else if (record.type === "model_change") {
    entry.model = nonEmptyText(record.modelId);
    // window は両方の組み合わせで引く。modelId だけでは引けない。
    entry.provider = nonEmptyText(record.provider);
  } else if (record.type === "thinking_level_change") {
    entry.effort = nonEmptyText(record.thinkingLevel);
  }

  // 捨てる種類のエントリも木には残す。parentId の鎖が切れると active branch を辿れない。
  reader.entries.set(entry.id, entry);
  reader.leafId = entry.id;
}

type Projected = {
  message: ChatMessage | null;
  model: string | null;
  provider: string | null;
  effort: string | null;
  usageTokens: number | null;
};

function project(id: string, message: Record<string, unknown>, entryTimestamp: unknown): Projected {
  const at = messageAt(message.timestamp, entryTimestamp);

  if (message.role === "user") {
    const text = userText(message.content);
    return {
      message: text === "" ? null : { id, role: "user", text, at },
      model: null,
      provider: null,
      effort: null,
      usageTokens: null,
    };
  }

  if (message.role === "assistant") {
    // ツール実行だけの返答は本文が空になる。会話としては出さないが、model と
    // thinkingLevel と usage は最新の値として使う。
    const text = assistantText(message.content);
    return {
      message: text === "" ? null : { id, role: "agent", text, at },
      model: nonEmptyText(message.model),
      provider: nonEmptyText(message.provider),
      effort: nonEmptyText(message.thinkingLevel),
      usageTokens: assistantUsageTokens(message),
    };
  }

  return { message: null, model: null, provider: null, effort: null, usageTokens: null };
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

function userText(content: unknown): string {
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

function messageAt(value: unknown, entryTimestamp: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof entryTimestamp === "string") {
    const parsed = Date.parse(entryTimestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function activeBranch(reader: ChatReader): SessionEntry[] {
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let id = reader.leafId;
  // 壊れた parentId で無限に辿らないよう、訪問済みで打ち切る。
  while (id !== null && !seen.has(id)) {
    const entry = reader.entries.get(id);
    if (!entry) break;
    seen.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function limitMessages(messages: readonly ChatMessage[]): {
  messages: ChatMessage[];
  truncated: boolean;
} {
  const kept: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const size = Buffer.byteLength(message.text, "utf8");
    // 1 件で上限を超える場合は、その 1 件だけを返す。
    if (kept.length > 0 && (kept.length >= MAX_MESSAGES || bytes + size > MAX_BYTES)) {
      return { messages: kept.reverse(), truncated: true };
    }
    kept.push(message);
    bytes += size;
  }

  return { messages: kept.reverse(), truncated: false };
}

async function snapshotOf(reader: ChatReader, windowFor: WindowResolver): Promise<ChatSnapshot> {
  let model: string | null = null;
  let provider: string | null = null;
  let effort: string | null = null;
  // usage は entry 単位で拾う。本文の無い assistant を project が捨てるため、message 側に
  // 持たせると tool-only の最後の応答を取りこぼす。
  let tokens: number | null = null;
  const messages: ChatMessage[] = [];

  for (const entry of activeBranch(reader)) {
    if (entry.message) messages.push(entry.message);
    // path 順で新しい方を採る。model_change が assistant より後なら切り替え後の値になる。
    if (entry.model !== null) {
      model = entry.model;
      provider = entry.provider;
    }
    if (entry.effort !== null) effort = entry.effort;
    if (entry.invalidatesUsage) tokens = null;
    if (entry.usageTokens !== null) tokens = entry.usageTokens;
  }

  // window は表示中のモデルで引く。usage を採った assistant のモデルで引くと、切り替え直後に
  // 新しい model 名と古いモデルの window が混ざる。
  const window = await windowFor(reader.path, provider, model);
  const limited = limitMessages(messages);
  return {
    etag: `${reader.etagPrefix}-${reader.generation}`,
    messages: limited.messages,
    model,
    effort,
    truncated: limited.truncated,
    context: foldContext(tokens, window),
  };
}

// 出す材料が無いときだけ context を null にする。{ tokens: null, window: null } は
// 契約の型では表せるが、BFF はこの形を作らない。
function foldContext(tokens: number | null, window: number | null): ChatContext | null {
  if (tokens === null && window === null) return null;
  return { tokens, window };
}

function createWindowResolver(
  sessionAgentDir: (sessionPath: string) => Promise<string | null>,
  loadCatalog: (agentDir: string) => Promise<ModelCatalog>,
): WindowResolver {
  const agentDirs = new Map<string, Promise<string | null>>();
  const catalogs = new Map<string, Promise<ModelCatalog>>();

  // セッション path もカタログも動かない前提。起動後に足したプロバイダや override は
  // BFF の再起動まで反映しない。ETag が session の generation だけで整合するのはこのため。
  const agentDirOf = (sessionPath: string): Promise<string | null> => {
    const cached = agentDirs.get(sessionPath);
    if (cached) return cached;
    const pending = sessionAgentDir(sessionPath).catch(() => null);
    agentDirs.set(sessionPath, pending);
    return pending;
  };

  const catalogFor = (agentDir: string): Promise<ModelCatalog> => {
    const cached = catalogs.get(agentDir);
    if (cached) return cached;
    const pending = loadCatalog(agentDir).catch(() => emptyCatalog());
    catalogs.set(agentDir, pending);
    return pending;
  };

  return async (sessionPath, provider, model) => {
    if (provider === null || model === null) return null;
    const agentDir = await agentDirOf(sessionPath);
    if (agentDir === null) return null;
    const catalog = await catalogFor(agentDir);
    return catalog.contextWindow(provider, model);
  };
}

// セッションは <agent-dir>/sessions/<slug>/<file>.jsonl に置かれる。BFF の
// $PI_CODING_AGENT_DIR は pi を custom dir で起動したセッションと一致しないため、path から
// 導く。models-store.json の実在を条件にして、別の root を agent dir と誤認しない。
async function sessionAgentDirOf(sessionPath: string): Promise<string | null> {
  const candidate = dirname(dirname(dirname(sessionPath)));
  try {
    const info = await stat(join(candidate, MODELS_STORE));
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function loadCatalogFrom(agentDir: string): Promise<ModelCatalog> {
  const [store, config] = await Promise.all([
    readJson(join(agentDir, MODELS_STORE)),
    readJson(join(agentDir, MODELS_CONFIG)),
  ]);
  return catalogOf(store, config);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // カタログが無い・壊れているときは window を出さない。会話は止めない。
    return null;
  }
}

function emptyCatalog(): ModelCatalog {
  return { contextWindow: () => null };
}

// models-store.json が取得済みカタログの土台で、models.json の modelOverrides が最後に
// 重なる（pi の getAllModels と同じ順序）。store に無いモデルは override を書いても引けない。
function catalogOf(store: unknown, config: unknown): ModelCatalog {
  const windows = new Map<string, number | null>();
  const providers = asRecord(store);
  const overrides = asRecord(asRecord(config)?.providers);

  for (const [provider, value] of Object.entries(providers ?? {})) {
    const models = asRecord(value)?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const record = asRecord(model);
      const id = nonEmptyText(record?.id);
      if (!id) continue;
      const override = asRecord(asRecord(overrides?.[provider])?.modelOverrides)?.[id];
      const overrideRecord = asRecord(override);
      const chosen =
        overrideRecord !== null && "contextWindow" in overrideRecord
          ? overrideRecord.contextWindow
          : record?.contextWindow;
      windows.set(catalogKey(provider, id), contextWindowValue(chosen));
    }
  }

  return {
    contextWindow(provider, model) {
      if (provider === null || model === null) return null;
      return windows.get(catalogKey(provider, model)) ?? null;
    },
  };
}

function catalogKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

// 0 以下や数値でない window は割合を壊す（Infinity）。pi の getContextUsage と同じく扱わない。
function contextWindowValue(value: unknown): number | null {
  const window = finiteNumber(value);
  return window !== null && window > 0 ? window : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reset(reader: ChatReader): void {
  clear(reader);
  reader.generation += 1;
}

// ファイルが消えた瞬間だけ世代を進める。ENOENT が続く間は同じ etag を返し、
// 一度もファイルを見ていない path は世代 0 のまま。
function forget(reader: ChatReader): void {
  if (reader.headerId === null) return;
  reset(reader);
  reader.headerId = null;
  reader.inode = null;
}

function clear(reader: ChatReader): void {
  reader.offset = 0;
  reader.pending = new Uint8Array(0);
  reader.entries.clear();
  reader.leafId = null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
