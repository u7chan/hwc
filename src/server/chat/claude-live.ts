import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVITY_TOK_PER_SECOND_LIMIT } from "../../shared/activity";
import { SESSION_ID } from "./claude-sidecar";

// mod（claude-mod）が生成中の速度だけを書く。phase は transcript から導くので持たない。
// 1 件は数百バイト。壊れた・巨大なファイルを読まないための上限。
const MAX_LIVE_BYTES = 4 * 1024;
const LIVE_VERSION = 1;

// 書き手は 500ms ごと、読み手は 1 秒ごと。1 回の取りこぼしで消えない程度に延ばす。
export const LIVE_TTL_MS = 2_500;

export type ClaudeLive = {
  // 計測できていない（要求中・停止直後）ときは null。
  tokPerSecond: number | null;
  at: number;
};

export function claudeLiveRoot(stateRoot: string): string {
  return join(stateRoot, "claude", "live");
}

export function livePath(root: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(root, `${sessionId}.json`) : null;
}

// BFF が読む。形が合わない・古い・別のセッションのものは無いものとして扱う。
export async function readLive(
  root: string,
  sessionId: string,
  now = Date.now(),
): Promise<ClaudeLive | null> {
  const path = livePath(root, sessionId);
  if (path === null) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_LIVE_BYTES) return null;
    return parseLive(JSON.parse(await readFile(path, "utf8")), sessionId, now);
  } catch {
    return null;
  }
}

// 途中書きの JSON は parse で落ちる。mod の fs.write は原子的でないので、読み手で弾く。
export function parseLive(value: unknown, sessionId: string, now: number): ClaudeLive | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== LIVE_VERSION || record.sessionId !== sessionId) return null;
  const at = record.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (Math.abs(now - at) > LIVE_TTL_MS) return null;

  const rate = record.tokPerSecond;
  if (rate === null) return { tokPerSecond: null, at };
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return { tokPerSecond: Math.min(rate, ACTIVITY_TOK_PER_SECOND_LIMIT), at };
}
