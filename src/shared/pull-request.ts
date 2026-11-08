// gh の応答も API の応答も、形が違えば PR として扱わない。URL は <a href> にそのまま
// 入るので、github.com の pull URL だけを受け付ける。
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/([1-9][0-9]*)$/;

export type PullRequest = { number: number; url: string };

export function parsePullRequest(value: unknown): PullRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { number, url } = value as { number?: unknown; url?: unknown };
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof url !== "string") return null;
  const match = PULL_URL.exec(url);
  if (match === null || Number(match[1]) !== number) return null;
  return { number, url };
}

// gh pr list の応答。open の PR は 1 件に絞ってあるので、先頭だけを見る。
export function parsePullRequestList(value: unknown): PullRequest | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return parsePullRequest(value[0]);
}
