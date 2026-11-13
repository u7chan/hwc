import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  attachmentCollisionName,
  isSafePaneId,
  isStoredAttachmentName,
  sanitizeAttachmentName,
} from "../shared/attachments";

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

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}
