import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVITY_TOK_PER_SECOND_LIMIT } from "../../shared/activity";
import { SESSION_ID } from "./claude-sidecar";
import type { ChatContext } from "./contract";

// mod（claude-mod）が生成中の速度とコンテキスト使用量を書く。phase は transcript から導くので
// 持たない。1 件は数百バイト。壊れた・巨大なファイルを読まないための上限。
const MAX_LIVE_BYTES = 4 * 1024;
const LIVE_VERSION = 1;

// 書き手は 500ms ごと、読み手は 1 秒ごと。1 回の取りこぼしで消えない程度に延ばす。
export const LIVE_TTL_MS = 2_500;

export type ClaudeLive = {
  // 計測できていない（要求中・停止直後）ときは null。鮮度が切れたら null にする。
  tokPerSecond: number | null;
  // ターンの終わりにしか動かないので、鮮度では捨てない。無ければ null。
  context: ChatContext | null;
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

  // 使用量はターンの終わりにしか変わらない。2.5 秒を過ぎたファイルでも、次のターンまで
  // 同じ値を持ち続けるので、速度の鮮度とは切り離して読む。
  const context = parseContext(record.context);
  const fresh = Math.abs(now - at) <= LIVE_TTL_MS;
  if (!fresh) return context === null ? null : { tokPerSecond: null, context, at };
  const rate = parseRate(record.tokPerSecond);
  return rate === undefined ? null : { tokPerSecond: rate, context, at };
}

// 圧縮は文脈を切り詰める。圧縮より前に書かれた使用量は圧縮前の量なので、次のターンまで出さない。
// 不明を 0% とも書かない（docs/adr/claude-integration.md）。
export function contextSince(
  live: ClaudeLive | null,
  compactedAt: number | null,
): ChatContext | null {
  if (live === null || live.context === null) return null;
  if (compactedAt !== null && live.at <= compactedAt) return null;
  return live.context;
}

// 形の合わない値は「無い」として扱う。使用量が壊れていても、速度まで捨てない。
function parseContext(value: unknown): ChatContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tokens = count(record.tokens, 0);
  const window = count(record.window, 1);
  if (tokens === null && window === null) return null;
  return { tokens, window };
}

function count(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return null;
  return Math.round(value);
}

// 速度が壊れているファイルは、使用量が読めても丸ごと無いものとして扱う（従来の契約）。
function parseRate(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, ACTIVITY_TOK_PER_SECOND_LIMIT);
}
