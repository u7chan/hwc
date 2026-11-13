import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import {
  attachmentCollisionName,
  attachmentExtFromName,
  isSafePaneId,
  isStoredAttachmentName,
  sanitizeAttachmentName,
} from "../shared/attachments";
import type { ChatSnapshot } from "./chat/contract";

// 同名で連番を試す回数。1 秒に 1000 枚を超える貼り付けは想定しない。
const MAX_NAME_ATTEMPTS = 1000;

// 保存先の根。作業ディレクトリに依存させないため、相対値は採らずに既定へ落とす。
// hwc が書き出すもの（添付・ペイン時刻・通知設定）はすべてこの下に置く（ADR 0018）。
export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HWC_STATE_DIR;
  if (explicit !== undefined && isAbsolute(explicit)) return explicit;
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
  return join(base, "hwc");
}

export function defaultAttachmentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultStateRoot(env), "attachments");
}

function paneDir(root: string, paneId: string): string | null {
  return isSafePaneId(paneId) ? join(root, paneId) : null;
}

// ペイン id は実在確認と検証を通したものだけを渡す。ここでも書式を確かめてから連結する。
export function attachmentFilePath(root: string, paneId: string, name: string): string | null {
  const dir = paneDir(root, paneId);
  if (dir === null || !isStoredAttachmentName(name)) return null;
  return join(dir, name);
}

export async function saveAttachment(options: {
  root: string;
  paneId: string;
  name: string;
  bytes: Uint8Array;
}): Promise<string | null> {
  const dir = paneDir(options.root, options.paneId);
  if (dir === null) return null;
  const base = sanitizeAttachmentName(options.name);
  if (base === "") return null;
  await mkdir(dir, { recursive: true });

  for (let index = 0; index < MAX_NAME_ATTEMPTS; index += 1) {
    const name = attachmentCollisionName(base, index);
    try {
      // wx は既存ファイルを上書きしない。同名の判定と書き込みを 1 手に畳む。
      await writeFile(join(dir, name), options.bytes, { flag: "wx" });
      return name;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  return null;
}

// 配信は ArrayBuffer で返す。write 側の Uint8Array をそのまま返すと、共有バッファの
// 可能性を型が排除できない。
export async function readAttachment(options: {
  root: string;
  paneId: string;
  name: string;
}): Promise<ArrayBuffer | null> {
  const path = attachmentFilePath(options.root, options.paneId, options.name);
  if (path === null) return null;
  try {
    return toArrayBuffer(await readFile(path));
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function attachmentExists(
  root: string,
  paneId: string,
  name: string,
): Promise<boolean> {
  const path = attachmentFilePath(root, paneId, name);
  if (path === null) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// 添付 1 件の実バイト数。名前は保存名の検証を通ったものだけを読み、消えたファイルは
// 値を持たせない（呼び出し側は名前だけを出す）。画像は履歴でサムネイルを出すだけで
// 大きさを表示しないため、stat しない。
async function attachmentSizes(
  root: string,
  paneId: string,
  names: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  await Promise.all(
    names.map(async (name) => {
      const path = attachmentFilePath(root, paneId, name);
      if (path === null || attachmentExtFromName(name) !== null) return;
      try {
        const info = await stat(path);
        if (info.isFile()) sizes.set(name, info.size);
      } catch {
        // 消えたファイルはサイズを出さない。名前は会話に残す。
      }
    }),
  );
  return sizes;
}

// サイズは本文が変わらないまま変わる（ファイルが消える）。etag に混ぜないと、
// 304 で古い大きさが残り続ける。
function withAttachmentSizes(
  etag: string,
  names: readonly string[],
  sizes: Map<string, number>,
): string {
  const parts = [...names]
    .sort()
    .map((name) => `${name}@${sizes.get(name) ?? "missing"}`)
    .join("\n");
  const digest = createHash("sha256").update(parts).digest("hex").slice(0, 12);
  return `${etag}-${digest}`;
}

// 会話の添付にサイズを足す。各 CLI の reader は保存先を知らないので、
// BFF がスナップショットを返す直前に埋める。
export async function attachAttachmentSizes(
  snapshot: ChatSnapshot,
  options: { root: string; paneId: string },
): Promise<ChatSnapshot> {
  const names = new Set<string>();
  for (const message of snapshot.messages) {
    for (const attachment of message.attachments ?? []) names.add(attachment.name);
  }
  if (names.size === 0) return snapshot;

  const sizes = await attachmentSizes(options.root, options.paneId, [...names]);
  const messages = snapshot.messages.map((message) => {
    if (message.attachments === undefined) return message;
    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        size: sizes.get(attachment.name) ?? null,
      })),
    };
  });
  return {
    ...snapshot,
    messages,
    etag: withAttachmentSizes(snapshot.etag, [...names], sizes),
  };
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}
