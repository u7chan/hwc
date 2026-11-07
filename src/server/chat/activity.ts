import { readFile, stat } from "node:fs/promises";
import { parseActivityFile, type PaneActivity } from "../../shared/activity";

// pi 拡張がセッションの隣に置く。path はセッション path から導き、クライアントからは受け取らない。
const ACTIVITY_SUFFIX = ".thinking.json";

// 想定は 1〜2KB。壊れた・巨大なファイルを読まないための上限。
const ACTIVITY_MAX_BYTES = 8 * 1024;

export function activityPath(sessionPath: string): string {
  return `${sessionPath}${ACTIVITY_SUFFIX}`;
}

// 拡張が入っていない・まだ書かれていない・壊れているときは null。会話の取得を止めない。
export async function readActivity(
  sessionPath: string,
  now = Date.now(),
): Promise<PaneActivity | null> {
  const path = activityPath(sessionPath);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > ACTIVITY_MAX_BYTES) return null;
    return parseActivityFile(JSON.parse(await readFile(path, "utf8")), now);
  } catch {
    return null;
  }
}
