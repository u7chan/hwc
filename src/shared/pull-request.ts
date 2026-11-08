// gh の応答も API の応答も、形が違えば PR として扱わない。URL は <a href> にそのまま
// 入るので、github.com の pull URL だけを受け付ける。
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/([1-9][0-9]*)$/;

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

export type PullRequest = {
  number: number;
  url: string;
  title: string;
  state: PullRequestState;
};

function parseState(value: unknown): PullRequestState | null {
  switch (value) {
    case "OPEN":
    case "MERGED":
    case "CLOSED":
      return value;
    default:
      return null;
  }
}

// gh のタイトルは 1 行だが、念のため空白を畳んでから表示に使う。
function parseTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title === "" ? null : title;
}

export function parsePullRequest(value: unknown): PullRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { number, url, title, state } = value as {
    number?: unknown;
    url?: unknown;
    title?: unknown;
    state?: unknown;
  };
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof url !== "string") return null;
  const match = PULL_URL.exec(url);
  if (match === null || Number(match[1]) !== number) return null;
  const parsedTitle = parseTitle(title);
  if (parsedTitle === null) return null;
  const parsedState = parseState(state);
  if (parsedState === null) return null;
  return { number, url, title: parsedTitle, state: parsedState };
}

// gh pr list の応答。最新の PR は 1 件に絞ってあるので、先頭だけを見る。
export function parsePullRequestList(value: unknown): PullRequest | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return parsePullRequest(value[0]);
}
