import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { asRecord, nonEmptyText } from "../../shared/json";
import { isRewindCapability } from "../../shared/rewind";
import { ChatUnavailableError } from "./errors";
import {
  askQuestionsFromContent,
  askResultsFromMessage,
  messageAt,
  project,
  projectCompaction,
  type SessionEntry,
} from "./pi-entry";

// 40MB のセッションを一度に読まないよう、追記分はチャンクに分けて読む。
const CHUNK_BYTES = 1024 * 1024;

// ヘッダ行だけは毎回読む。1 行がこれより長いセッションは想定しない。
const HEADER_PROBE_BYTES = 128 * 1024;

const CURRENT_VERSION = 3;

export type ChatReader = {
  path: string;
  offset: number;
  pending: Uint8Array;
  entries: Map<string, SessionEntry>;
  leafId: string | null;
  headerId: string | null;
  inode: number | null;
  generation: number;
  // セッション内のどこかに hwc-capabilities があれば true。枝を跨いでも保持する。
  canRewind: boolean;
  etagPrefix: string;
};

export function createReader(path: string): ChatReader {
  return {
    path,
    offset: 0,
    pending: new Uint8Array(0),
    entries: new Map(),
    leafId: null,
    headerId: null,
    inode: null,
    generation: 0,
    canRewind: false,
    // path のハッシュだけでなく、BFF の起動ごとに変わる id を混ぜる。
    // 再起動後に古い ETag と一致させないため。
    etagPrefix: `${hashPath(path)}-${randomUUID()}`,
  };
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export async function readHeader(handle: FileHandle): Promise<string> {
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

export async function consume(reader: ChatReader, handle: FileHandle, size: number): Promise<void> {
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
    askQuestions: [],
    askResults: [],
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
      const at = messageAt(message.timestamp, record.timestamp);
      entry.askQuestions = askQuestionsFromContent(message.content, at);
      entry.askResults = askResultsFromMessage(message, at);
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
  if (isRewindCapability(record)) reader.canRewind = true;
  reader.entries.set(entry.id, entry);
  reader.leafId = entry.id;
}

export function activeBranch(reader: ChatReader): SessionEntry[] {
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

export function reset(reader: ChatReader): void {
  clear(reader);
  reader.generation += 1;
}

// ファイルが消えた瞬間だけ世代を進める。ENOENT が続く間は同じ etag を返し、
// 一度もファイルを見ていない path は世代 0 のまま。
export function forget(reader: ChatReader): void {
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
  reader.canRewind = false;
}

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
