import { parsePullRequestList, type PullRequest } from "../shared/pull-request";
import { childEnv } from "./child-process";

// gh はプロセス起動とネットワークを伴う。ブランチ（.git/HEAD の読み取り）と同じ経路に
// 置くと、状態を取り直すたびに一覧全体が gh 待ちになる。
export const PULL_REQUEST_TIMEOUT_MS = 5_000;
export const PULL_REQUEST_TTL_MS = 60_000;
// PR の無いブランチの方が多い。ペインを開き直すたびに gh を起動しないよう長めに覚える。
export const PULL_REQUEST_MISSING_TTL_MS = 120_000;

export type PullRequestReader = (options: {
  checkoutPath: string;
  // PR はリモートの head ブランチに属す。push 先の名前を先頭に、ローカル名を後ろに置く。
  branches: readonly string[];
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

  return async ({ checkoutPath, branches, refresh = false }) => {
    const candidates = candidateBranches(branches);
    if (candidates.length === 0) return null;
    // ブランチを切り替えても、push 先が変わっても PR は変わる。どちらも鍵に含めて読み直す。
    const key = `${checkoutPath}\n${candidates.join("\n")}`;
    const at = now();
    if (!refresh) {
      const hit = cache.get(key);
      if (hit !== undefined && at - hit.at < hit.ttlMs) return hit.pullRequest;
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
    }

    const lookup = (async () => {
      let pullRequest: PullRequest | null = null;
      // push 先の名前で引く。Herdr の自動生成名のまま push されているとは限らず、
      // PR の head は push した側の名前になる。見つからなければローカル名も見る。
      for (const branch of candidates) {
        try {
          pullRequest = parsePullRequestList(await run(checkoutPath, branch));
        } catch {
          // gh が無い・未認証・オフライン・期限切れは、その候補で PR が無いのと同じに
          // 扱い、次の候補へ進む。どの候補でも引けなければチップ無しになる。
          pullRequest = null;
        }
        if (pullRequest !== null) break;
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

// PR は push 先の head ブランチに属す。push 先を先に、ローカル名を後ろにした候補を作る。
// 同じ名前なら 1 つ。呼び出し側ごとに規則を持たず、ここを正本にする。
export function pullRequestBranches(
  branch: string,
  upstreamBranch: string | null,
): readonly string[] {
  return upstreamBranch === null || upstreamBranch === branch ? [branch] : [upstreamBranch, branch];
}

// 同じブランチを二度引かない。候補は push 先とローカル名で、通常はどちらか一方だけ。
function candidateBranches(branches: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const branch of branches) {
    if (branch !== "" && !candidates.includes(branch)) candidates.push(branch);
  }
  return candidates;
}

async function listLatestPullRequests(checkoutPath: string, branch: string): Promise<unknown> {
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
      "number,url,title,state,headRefOid",
    ],
    {
      cwd: checkoutPath,
      env: childEnv(),
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
