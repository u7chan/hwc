import { type FileHandle, open } from "node:fs/promises";
import { asRecord } from "../../shared/json";
import { parseRewindMarker, type RewindMarker } from "../../shared/rewind";
import { userText } from "./pi-entry";
import { isEnoent } from "./pi-reader";

const REWIND_SCAN_BYTES = 256 * 1024;

export type RewindRead = {
  marker: RewindMarker | null;
  sentText: string | null;
  // 次回はここから読む。未完行は消費しない。
  offset: number;
  inode: number | null;
};

// 編集待ち専用の tail reader。chat reader の offset / pending を共有しない。
// marker は移動後の葉を親に持ち、その後に送った本文が続く。
export async function readRewindMarker(
  path: string,
  offset: number,
  requestId: string,
  expectedInode: number | null = null,
): Promise<RewindRead> {
  let start = Math.max(0, offset);
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isEnoent(error)) {
      return { marker: null, sentText: null, offset: start, inode: null };
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    const size = info.size;
    // ファイルが書き換わったときは、40MB を読み直さず末尾だけを見る。
    if (size < start || (expectedInode !== null && info.ino !== expectedInode)) {
      start = Math.max(0, size - REWIND_SCAN_BYTES);
    }
    const length = Math.min(size - start, REWIND_SCAN_BYTES);
    if (length <= 0) return { marker: null, sentText: null, offset: start, inode: info.ino };

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { marker: null, sentText: null, offset: start, inode: info.ino };
    }

    let marker: RewindMarker | null = null;
    let sentText: string | null = null;
    for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(raw);
      if (record === null) continue;
      if (marker === null) {
        const parsed = parseRewindMarker(record);
        if (parsed !== null && parsed.requestId === requestId) marker = parsed;
        continue;
      }
      if (sentText !== null || record.type !== "message") continue;
      const message = asRecord(record.message);
      if (message?.role !== "user") continue;
      const text = userText(message.content).trim();
      if (text !== "") sentText = text;
    }
    return { marker, sentText, offset: start + lastNewline + 1, inode: info.ino };
  } finally {
    await handle.close().catch(() => {
      // 読み取りは終わっている。閉じ損ねても次の要求で開き直せる。
    });
  }
}
