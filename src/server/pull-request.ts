import { parsePullRequestList, type PullRequest } from "../shared/pull-request";

// gh はプロセス起動とネットワークを伴う。ブランチ（.git/HEAD の読み取り）と同じ経路に
// 置くと、状態を取り直すたびに一覧全体が gh 待ちになる。
export const PULL_REQUEST_TIMEOUT_MS = 5_000;
export const PULL_REQUEST_TTL_MS = 60_000;
// PR の無いブランチの方が多い。ペインを開き直すたびに gh を起動しないよう長めに覚える。
export const PULL_REQUEST_MISSING_TTL_MS = 120_000;

export type PullRequestReader = (options: {
  checkoutPath: string;
  branch: string;
  // 一覧に戻ったときに、ブランチの状態変化を待たずに引き直すための口。
  refresh?: boolean;
}) => Promise<PullRequest | null>;

export function createPullRequestReader(
  options: {
    run?: (checkoutPath: string, branch: string) => Promise<unknown>;
    ttlMs?: number;
    missingTtlMs?: number;
    now?: () => number;
  } = {},
): PullRequestReader {
  const run = options.run ?? listLatestPullRequests;
  const ttlMs = options.ttlMs ?? PULL_REQUEST_TTL_MS;
  const missingTtlMs = options.missingTtlMs ?? PULL_REQUEST_MISSING_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { pullRequest: PullRequest | null; at: number; ttlMs: number }>();
  // 分割セルは同じスペースの PR を同時に引く。進行中の問い合わせを共有し、gh の起動を
  // セル数ぶん増やさない。
  const inFlight = new Map<string, Promise<PullRequest | null>>();

  return async ({ checkoutPath, branch, refresh = false }) => {
    // ブランチ切り替えのイベントは無いので、ブランチ名を鍵に含めて読み直す。
    const key = `${checkoutPath}\n${branch}`;
    const at = now();
    if (!refresh) {
      const hit = cache.get(key);
      if (hit !== undefined && at - hit.at < hit.ttlMs) return hit.pullRequest;
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
    }

    const lookup = (async () => {
      let pullRequest: PullRequest | null = null;
      try {
        pullRequest = parsePullRequestList(await run(checkoutPath, branch));
      } catch {
        // gh が無い・未認証・オフライン・期限切れは、PR が無い場合と同じ扱いにする。
        // 表示はどちらもチップ無しなので、区別しても利用者に伝えることがない。
      }
      cache.set(key, {
        pullRequest,
        at,
        ttlMs: pullRequest === null ? missingTtlMs : ttlMs,
      });
      return pullRequest;
    })();

    inFlight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (inFlight.get(key) === lookup) inFlight.delete(key);
    }
  };
}

async function listLatestPullRequests(checkoutPath: string, branch: string): Promise<unknown> {
  // HERDR_ を継ぐとペイン扱いになる。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const child = Bun.spawn(
    [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,url,title,state",
    ],
    {
      cwd: checkoutPath,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: PULL_REQUEST_TIMEOUT_MS,
    },
  );
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("gh pr list failed");
  return JSON.parse(text);
}
