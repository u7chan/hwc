import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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

// ペインの cwd はリポジトリのサブディレクトリのこともある。.git が見つかるまで上へたどる。
async function readFrom(directory: string): Promise<string | null> {
  const dotGit = join(directory, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return parseBranchHead(await readFile(join(dotGit, "HEAD"), "utf8"));
  const dir = parseGitDirFile(await readFile(dotGit, "utf8"));
  if (dir === null) return null;
  const head = isAbsolute(dir) ? join(dir, "HEAD") : join(directory, dir, "HEAD");
  return parseBranchHead(await readFile(head, "utf8"));
}

export async function readBranch(checkoutPath: string): Promise<string | null> {
  if (!isAbsolute(checkoutPath)) return null;
  let directory = checkoutPath;
  // ルートより上は無い。深さの上限は念のためで、通常は数階層で見つかる。
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return await readFrom(directory);
    } catch {
      // ここに .git が無いだけかもしれないので、親を見る。
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
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
