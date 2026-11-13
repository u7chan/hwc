import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ChatCompaction,
  ChatContext,
  ChatMessage,
  ChatSnapshot,
  ChatUsage,
  SessionChatClient,
} from "./contract";
import { stripAttachedFiles } from "../../shared/attachments";
import { ChatUnavailableError } from "./errors";
import { limitMessages } from "./limit";
import { loadPiModelWindows, type PiModelWindow } from "./pi-models";

// 40MB のセッションを一度に読まないよう、追記分はチャンクに分けて読む。
const CHUNK_BYTES = 1024 * 1024;

// ヘッダ行だけは毎回読む。1 行がこれより長いセッションは想定しない。
const HEADER_PROBE_BYTES = 128 * 1024;

const CURRENT_VERSION = 3;

const MODELS_STORE = "models-store.json";
const MODELS_CONFIG = "models.json";

export { ChatUnavailableError };

export type ChatClient = SessionChatClient;

type ModelCatalog = {
  contextWindow: (provider: string, model: string) => number | null | undefined;
};

type WindowResolver = (
  sessionPath: string,
  provider: string | null,
  model: string | null,
) => Promise<number | null>;

type SessionCompaction = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number | null;
  at: number;
};

type SessionEntry = {
  id: string;
  parentId: string | null;
  // 1 エントリが 1 行とは限らない。失敗した assistant は本文と失敗の 2 行になる。
  messages: ChatMessage[];
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
    readCatalogFile?: (path: string) => Promise<string>;
    loadPiModels?: (agentDir: string) => Promise<PiModelWindow[]>;
  } = {},
): ChatClient {
  const limit = options.limit ?? 8;
  const windowFor = createWindowResolver(
    options.readCatalogFile ?? ((path) => readFile(path, "utf8")),
    options.loadPiModels ?? loadPiModelWindows,
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
    messages: [],
    model: null,
    provider: null,
    effort: null,
    usageTokens: null,
    usage: null,
    // compaction と context_edit は、それ以前の usage を現在のコンテキスト量にしない。
    invalidatesUsage: record.type === "compaction" || record.type === "context_edit",
    compactionEntry: record.type === "compaction",
    compaction: null,
  };

  if (record.type === "message") {
    const message = asRecord(record.message);
    if (message) {
      const projected = project(entry.id, message, record.timestamp);
      entry.messages = projected.messages;
      entry.model = projected.model;
      entry.provider = projected.provider;
      entry.effort = projected.effort;
      entry.usageTokens = projected.usageTokens;
      entry.usage = projected.usage;
    }
  } else if (record.type === "model_change") {
    entry.model = nonEmptyText(record.modelId);
    // window は両方の組み合わせで引く。modelId だけでは引けない。
    entry.provider = nonEmptyText(record.provider);
  } else if (record.type === "thinking_level_change") {
    entry.effort = nonEmptyText(record.thinkingLevel);
  } else if (record.type === "compaction") {
    entry.compaction = projectCompaction(record);
  }

  // 捨てる種類のエントリも木には残す。parentId の鎖が切れると active branch を辿れない。
  reader.entries.set(entry.id, entry);
  reader.leafId = entry.id;
}

type Projected = {
  messages: ChatMessage[];
  model: string | null;
  provider: string | null;
  effort: string | null;
  usageTokens: number | null;
  usage: ChatUsage | null;
};

// 要約の無い compaction は材料にしない。要約だけ出して窓がずれる状態を作らないため。
function projectCompaction(record: Record<string, unknown>): SessionCompaction | null {
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

function project(id: string, message: Record<string, unknown>, entryTimestamp: unknown): Projected {
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

async function snapshotOf(reader: ChatReader, windowFor: WindowResolver): Promise<ChatSnapshot> {
  let model: string | null = null;
  let provider: string | null = null;
  let effort: string | null = null;
  // usage は entry 単位で拾う。本文の無い assistant を project が捨てるため、message 側に
  // 持たせると tool-only の最後の応答を取りこぼす。
  let tokens: number | null = null;
  let usage: ChatUsage | null = null;
  const messages: ChatMessage[] = [];
  // compaction エントリより前にある、表示対象のメッセージ数。区切りを置く位置になる。
  let beforeCompaction = 0;

  const branch = activeBranch(reader);
  const compacted = compactionWindow(branch);
  // pi は自動リトライの試行ごとに同じ失敗を書く。同一文言の error が続く間は 1 行に畳み、
  // 試行回数だけを count に残す。行が減るので区切りの位置は畳んだあとの行数で数える。
  let retry: ChatMessage | null = null;

  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (!entry) continue;
    // 畳んだ行は区切りの手前に残る。またぐと、圧縮後の失敗が圧縮前の行の回数に入る。
    if (entry.compactionEntry) retry = null;
    const before = messages.length;
    // 圧縮より前の会話はモデルの文脈にもう無い。返さない。
    if (index >= (compacted?.start ?? 0)) {
      for (const message of entry.messages) {
        if (message.role === "error" && retry !== null && retry.text === message.text) {
          retry.count = (retry.count ?? 1) + 1;
          continue;
        }
        // 最初の失敗の id を残す。試行が増えても行の id を変えない。
        retry = message.role === "error" ? { ...message } : null;
        messages.push(retry ?? message);
      }
    }
    if (compacted !== null && index < compacted.entryIndex) {
      beforeCompaction += messages.length - before;
    }
    // path 順で新しい方を採る。model_change が assistant より後なら切り替え後の値になる。
    if (entry.model !== null) {
      model = entry.model;
      provider = entry.provider;
    }
    if (entry.effort !== null) effort = entry.effort;
    if (entry.invalidatesUsage) {
      tokens = null;
      usage = null;
    }
    if (entry.usageTokens !== null) {
      tokens = entry.usageTokens;
      usage = entry.usage;
    }
  }

  // window は表示中のモデルで引く。usage を採った assistant のモデルで引くと、切り替え直後に
  // 新しい model 名と古いモデルの window が混ざる。
  const windowTokens = await windowFor(reader.path, provider, model);
  const limited = limitMessages(messages);
  // limitMessages は古い側から落とす。落ちた分だけ区切りの位置も手前へずらす。
  const dropped = messages.length - limited.messages.length;
  const compactionIndex =
    compacted === null
      ? 0
      : Math.max(0, Math.min(limited.messages.length, beforeCompaction - dropped));
  return {
    etag: `${reader.etagPrefix}-${reader.generation}-${windowTokens ?? "unknown"}`,
    messages: limited.messages,
    model,
    effort,
    truncated: limited.truncated,
    context: foldContext(tokens, windowTokens),
    ...(usage === null ? {} : { usage }),
    compaction: compacted === null ? null : { ...compacted.compaction, index: compactionIndex },
  };
}

// 最新の compaction だけを見る。その材料が揃い、firstKeptEntryId が branch にあれば
// その位置を返す。古い compaction へは遡らない。最新が使えないなら窓を張らず全体を返す。
// 要約だけ出して古い会話を並べるより、表示と実体が一致する側を選ぶ。
function compactionWindow(
  branch: readonly SessionEntry[],
): { start: number; entryIndex: number; compaction: Omit<ChatCompaction, "index"> } | null {
  let newestIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (!branch[index]?.compactionEntry) continue;
    newestIndex = index;
    break;
  }

  const newest = newestIndex < 0 ? null : branch[newestIndex];
  const found = newest?.compaction ?? null;
  if (found === null) return null;
  const start = branch.findIndex((entry) => entry.id === found.firstKeptEntryId);
  if (start < 0) return null;
  return {
    start,
    entryIndex: newestIndex,
    compaction: { at: found.at, tokensBefore: found.tokensBefore, summary: found.summary },
  };
}

// 出す材料が無いときだけ context を null にする。{ tokens: null, window: null } は
// 契約の型では表せるが、BFF はこの形を作らない。
function foldContext(tokens: number | null, window: number | null): ChatContext | null {
  if (tokens === null && window === null) return null;
  return { tokens, window };
}

function createWindowResolver(
  readCatalogFile: (path: string) => Promise<string>,
  loadPiModels: (agentDir: string) => Promise<PiModelWindow[]>,
): WindowResolver {
  type FileValue = { version: string | null; value: unknown };
  const files = new Map<string, { version: string; value: unknown }>();
  const catalogs = new Map<
    string,
    { store: FileValue; config: FileValue; catalog: ModelCatalog }
  >();
  const running = new Map<string, Promise<ModelCatalog>>();
  const fallback = new Map<string, { catalog: ModelCatalog; pending: Promise<PiModelWindow[]> }>();

  const readJson = async (path: string): Promise<FileValue> => {
    let version: string | null = null;
    try {
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) {
        files.delete(path);
        return { version, value: null };
      }
      // 同サイズの上書きと atomic rename も拾う。時刻は丸めずに比較する。
      version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const cached = files.get(path);
      if (cached?.version === version) return cached;
      const value: unknown = JSON.parse(await readCatalogFile(path));
      files.set(path, { version, value });
      return { version, value };
    } catch {
      // 失敗を覚えると、メタデータが同じまま読み取りが復旧しても再試行できない。
      files.delete(path);
      return { version, value: null };
    }
  };

  const catalogFor = (agentDir: string): Promise<ModelCatalog> => {
    const inFlight = running.get(agentDir);
    if (inFlight) return inFlight;

    const pending = Promise.all([
      readJson(join(agentDir, MODELS_STORE)),
      readJson(join(agentDir, MODELS_CONFIG)),
    ])
      .then(([store, config]) => {
        const cached = catalogs.get(agentDir);
        if (
          cached &&
          cached.store.value === store.value &&
          cached.store.version === store.version &&
          cached.config.value === config.value &&
          cached.config.version === config.version
        )
          return cached.catalog;
        const catalog = catalogOf(store.value, config.value);
        catalogs.set(agentDir, { store, config, catalog });
        return catalog;
      })
      .finally(() => running.delete(agentDir));
    running.set(agentDir, pending);
    return pending;
  };

  return async (sessionPath, provider, model) => {
    if (provider === null || model === null) return null;
    const agentDir = await sessionAgentDirOf(sessionPath);
    if (agentDir === null) return null;
    const catalog = await catalogFor(agentDir);
    const stored = catalog.contextWindow(provider, model);
    if (stored !== undefined) return stored;
    let cached = fallback.get(agentDir);
    if (cached?.catalog !== catalog) {
      const pending = loadPiModels(agentDir);
      cached = { catalog, pending };
      fallback.set(agentDir, cached);
      void pending.catch(() => {
        if (fallback.get(agentDir)?.pending === pending) fallback.delete(agentDir);
      });
    }
    const models = await cached.pending.catch(() => []);
    return models.find((item) => item.provider === provider && item.id === model)?.window ?? null;
  };
}

// セッションは <agent-dir>/sessions/<slug>/<file>.jsonl に置かれる。BFF の
// $PI_CODING_AGENT_DIR は pi を custom dir で起動したセッションと一致しないため、path から導く。
async function sessionAgentDirOf(sessionPath: string): Promise<string | null> {
  if (basename(dirname(dirname(sessionPath))) !== "sessions") return null;
  const candidate = dirname(dirname(dirname(sessionPath)));
  try {
    const info = await stat(candidate);
    return info.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
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
      return windows.get(catalogKey(provider, model));
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
