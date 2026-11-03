import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// HEAD は "ref: refs/heads/<branch>"、detached なら sha。detached はブランチではないので出さない。
export function parseBranchHead(text: string): string | null {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const prefix = "ref: refs/heads/";
  if (!line.startsWith(prefix)) return null;
  const name = line.slice(prefix.length).trim();
  return name === "" ? null : name;
}

// リンクワークツリーでは .git がファイルで、gitdir に本物の置き場所が書いてある。
export function parseGitDirFile(text: string): string | null {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const prefix = "gitdir:";
  if (!line.toLowerCase().startsWith(prefix)) return null;
  const path = line.slice(prefix.length).trim();
  return path === "" ? null : path;
}

export async function readBranch(checkoutPath: string): Promise<string | null> {
  const dotGit = join(checkoutPath, ".git");
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return parseBranchHead(await readFile(join(dotGit, "HEAD"), "utf8"));
    const dir = parseGitDirFile(await readFile(dotGit, "utf8"));
    if (dir === null) return null;
    const head = isAbsolute(dir) ? join(dir, "HEAD") : join(checkoutPath, dir, "HEAD");
    return parseBranchHead(await readFile(head, "utf8"));
  } catch {
    // git 管理外・権限なし・壊れた .git は、ブランチを出さないだけにする。
    return null;
  }
}

export type BranchReader = (checkoutPath: string) => Promise<string | null>;

// ブランチを切り替えても Herdr からイベントは来ない。毎回読むと重いので少しだけ覚える。
export function createBranchReader(
  options: { ttlMs?: number; now?: () => number } = {},
): BranchReader {
  const ttlMs = options.ttlMs ?? 4_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { branch: string | null; at: number }>();

  return async (checkoutPath) => {
    const at = now();
    const hit = cache.get(checkoutPath);
    if (hit !== undefined && at - hit.at < ttlMs) return hit.branch;
    const branch = await readBranch(checkoutPath);
    cache.set(checkoutPath, { branch, at });
    return branch;
  };
}
