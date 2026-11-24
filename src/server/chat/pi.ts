import { type FileHandle, open, readFile } from "node:fs/promises";
import type { ChatSnapshot, SessionChatClient } from "./contract";
import { loadPiModelWindows, type PiModelWindow } from "./pi-models";
import { snapshotOf } from "./pi-projection";
import {
  consume,
  createReader,
  forget,
  isEnoent,
  readHeader,
  reset,
  type ChatReader,
} from "./pi-reader";
import { createWindowResolver, type WindowResolver } from "./pi-window";

export type ChatClient = SessionChatClient;

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
