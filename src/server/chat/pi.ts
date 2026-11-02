import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import type { ChatMessage, ChatSnapshot } from "./contract";

// 直近の会話だけを返す。古い側は端末出力で読める。
const MAX_MESSAGES = 500;
const MAX_BYTES = 1024 * 1024;

// 40MB のセッションを一度に読まないよう、追記分はチャンクに分けて読む。
const CHUNK_BYTES = 1024 * 1024;

// ヘッダ行だけは毎回読む。1 行がこれより長いセッションは想定しない。
const HEADER_PROBE_BYTES = 128 * 1024;

const CURRENT_VERSION = 3;

export class ChatUnavailableError extends Error {}

export type ChatClient = {
  snapshot: (sessionPath: string) => Promise<ChatSnapshot>;
};

type SessionEntry = {
  id: string;
  parentId: string | null;
  message: ChatMessage | null;
  model: string | null;
  effort: string | null;
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
  options: { limit?: number; load?: (reader: ChatReader) => Promise<ChatSnapshot> } = {},
): ChatClient {
  const limit = options.limit ?? 8;
  const load = options.load ?? readSessionFile;
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

async function readSessionFile(reader: ChatReader): Promise<ChatSnapshot> {
  let handle: FileHandle;
  try {
    handle = await open(reader.path, "r");
  } catch (error) {
    // セッションはまだ作られていない。空の会話として扱う。
    if (!isEnoent(error)) throw error;
    forget(reader);
    return snapshotOf(reader);
  }

  try {
    const stat = await handle.stat();
    const headerId = await readHeader(handle);
    // pi は v1/v2 のセッションを開くと v3 へ rewrite する。同じ inode の truncate で
    // 前より長くなることがあるため、size と inode では書き換えを検出できない。
    // ヘッダ id は毎回読んで比べる。
    const replaced =
      (reader.headerId !== null && reader.headerId !== headerId) ||
      (reader.inode !== null && reader.inode !== stat.ino) ||
      reader.offset > stat.size;
    if (replaced) reset(reader);

    reader.inode = stat.ino;
    reader.headerId = headerId;
    await consume(reader, handle, stat.size);
    return snapshotOf(reader);
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
    effort: null,
  };

  if (record.type === "message") {
    const message = asRecord(record.message);
    if (message) {
      const projected = project(entry.id, message, record.timestamp);
      entry.message = projected.message;
      entry.model = projected.model;
      entry.effort = projected.effort;
    }
  } else if (record.type === "model_change") {
    entry.model = nonEmptyText(record.modelId);
  } else if (record.type === "thinking_level_change") {
    entry.effort = nonEmptyText(record.thinkingLevel);
  }

  // 捨てる種類のエントリも木には残す。parentId の鎖が切れると active branch を辿れない。
  reader.entries.set(entry.id, entry);
  reader.leafId = entry.id;
}

function project(
  id: string,
  message: Record<string, unknown>,
  entryTimestamp: unknown,
): { message: ChatMessage | null; model: string | null; effort: string | null } {
  const at = messageAt(message.timestamp, entryTimestamp);

  if (message.role === "user") {
    const text = userText(message.content);
    return {
      message: text === "" ? null : { id, role: "user", text, at },
      model: null,
      effort: null,
    };
  }

  if (message.role === "assistant") {
    // ツール実行だけの返答は本文が空になる。会話としては出さないが、model と
    // thinkingLevel は最新の値として使う。
    const text = assistantText(message.content);
    return {
      message: text === "" ? null : { id, role: "agent", text, at },
      model: nonEmptyText(message.model),
      effort: nonEmptyText(message.thinkingLevel),
    };
  }

  return { message: null, model: null, effort: null };
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

function snapshotOf(reader: ChatReader): ChatSnapshot {
  let model: string | null = null;
  let effort: string | null = null;
  const messages: ChatMessage[] = [];

  for (const entry of activeBranch(reader)) {
    if (entry.message) messages.push(entry.message);
    // path 順で新しい方を採る。model_change が assistant より後なら切り替え後の値になる。
    if (entry.model !== null) model = entry.model;
    if (entry.effort !== null) effort = entry.effort;
  }

  const limited = limitMessages(messages);
  return {
    etag: `${reader.etagPrefix}-${reader.generation}`,
    messages: limited.messages,
    model,
    effort,
    truncated: limited.truncated,
  };
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
