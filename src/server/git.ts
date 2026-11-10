import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseGitHubRemote, parseUpstreamTrack, type GitSync } from "../shared/git";

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

// `git remote -v` の "<name>\t<url> (fetch|push)" を読む。同じリモートに fetch と push が
// あるので、fetch を優先して 1 つに畳む。URL が読めない行は無視する。
export function parseRemoteUrls(text: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
    if (match === null) continue;
    const [, name, url, kind] = match;
    if (kind === "fetch" || !remotes.has(name)) remotes.set(name, url);
  }
  return remotes;
}

// 複数のリモートがあるときは origin を優先する。origin が GitHub でなければ、
// 他のリモートに GitHub のものがあればそれを使う。どれも GitHub でなければ null。
export function pickGitHubRepoUrl(remotes: ReadonlyMap<string, string>): string | null {
  const origin = remotes.get("origin");
  const originUrl = origin === undefined ? null : parseGitHubRemote(origin);
  if (originUrl !== null) return originUrl;
  for (const url of remotes.values()) {
    const parsed = parseGitHubRemote(url);
    if (parsed !== null) return parsed;
  }
  return null;
}

export type GitClient = {
  read: (options: { checkoutPath: string; branch: string }) => Promise<GitSync | null>;
  invalidate: (checkoutPath: string) => void;
  fetch: (checkoutPath: string) => Promise<void>;
  pull: (checkoutPath: string) => Promise<void>;
};

export const GIT_READ_TIMEOUT_MS = 5_000;
export const GIT_ACTION_TIMEOUT_MS = 60_000;
// ブランチ切替のイベントは無い。短い TTL で読み直し、fetch / pull の後は明示的に捨てる。
export const GIT_SYNC_TTL_MS = 10_000;

export function createGitClient(
  options: {
    ttlMs?: number;
    now?: () => number;
    runRead?: (checkoutPath: string, args: string[]) => Promise<string>;
    runAction?: (checkoutPath: string, args: string[]) => Promise<void>;
  } = {},
): GitClient {
  const ttlMs = options.ttlMs ?? GIT_SYNC_TTL_MS;
  const now = options.now ?? Date.now;
  const runRead = options.runRead ?? readGit;
  const runAction = options.runAction ?? runGitAction;
  const cache = new Map<string, { sync: GitSync | null; at: number }>();
  // 読み取りの途中で invalidate された結果をキャッシュへ戻さないための世代。
  let generation = 0;

  const read: GitClient["read"] = async ({ checkoutPath, branch }) => {
    if (!isAbsolute(checkoutPath) || branch === "") return null;
    const started = generation;
    const key = `${checkoutPath}\n${branch}`;
    const at = now();
    const hit = cache.get(key);
    if (hit !== undefined && at - hit.at < ttlMs) return hit.sync;

    let sync: GitSync | null = null;
    try {
      const [remotes, refs] = await Promise.all([
        runRead(checkoutPath, ["remote", "-v"]),
        runRead(checkoutPath, [
          "for-each-ref",
          "--format=%(upstream:short)\t%(upstream:track)",
          `refs/heads/${branch}`,
        ]),
      ]);
      const byName = parseRemoteUrls(remotes);
      sync = {
        ...parseUpstreamTrack(refs),
        hasRemote: byName.size > 0,
        repoUrl: pickGitHubRepoUrl(byName),
      };
    } catch {
      // git が無い・リポジトリが壊れている・期限切れでは、同期状態だけを出さない。
      // ブランチの表示は .git/HEAD から読めているので残す。
    }
    // 読み取り中に fetch / pull が終わっていたら、この値は操作前のものかもしれない。
    // キャッシュに戻すと、次の状態公開が古い値を読んでしまう。
    if (started === generation) cache.set(key, { sync, at });
    return sync;
  };

  const invalidate = (checkoutPath: string) => {
    generation += 1;
    const prefix = `${checkoutPath}\n`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  };

  return {
    read,
    invalidate,
    fetch: (checkoutPath) => runAction(checkoutPath, ["fetch"]),
    pull: (checkoutPath) => runAction(checkoutPath, ["pull", "--ff-only"]),
  };
}

function gitEnv(): Record<string, string | undefined> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  // 認証プロンプトで固まらない。hwc から呼ぶ git は対話できない。
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function readGit(checkoutPath: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: checkoutPath,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_READ_TIMEOUT_MS,
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("git read failed");
  return text;
}

async function runGitAction(checkoutPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: checkoutPath,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: GIT_ACTION_TIMEOUT_MS,
  });
  const code = await child.exited;
  if (code !== 0) throw new Error("git action failed");
}
