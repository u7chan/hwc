export type GitSync = {
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  // GitHub のリポジトリトップ。GitHub 以外のリモートや、読めないときは null。
  repoUrl: string | null;
};

export type UpstreamTrack = {
  upstream: string | null;
  ahead: number;
  behind: number;
};

// `git for-each-ref` の `%(upstream:short)` と `%(upstream:track)` を 1 行で受ける。
// track は [ahead 1, behind 2] / [ahead 1] / [behind 2] / [gone] / 空のいずれか。
export function parseUpstreamTrack(text: string): UpstreamTrack {
  const line = text.trim().split("\n")[0] ?? "";
  if (line === "") return { upstream: null, ahead: 0, behind: 0 };
  const tab = line.indexOf("\t");
  const upstream = (tab === -1 ? line : line.slice(0, tab)).trim();
  const track = tab === -1 ? "" : line.slice(tab + 1).trim();
  // 上流が消えている場合、リモートのブランチはもう無い。fetch だけを残す。
  if (upstream === "" || track.includes("gone")) {
    return { upstream: null, ahead: 0, behind: 0 };
  }
  return {
    upstream,
    ahead: toCount(/ahead (\d+)/.exec(track)?.[1]),
    behind: toCount(/behind (\d+)/.exec(track)?.[1]),
  };
}

const GITHUB_OWNER = /^[A-Za-z0-9._-]+$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/;

// remote の URL は ssh / https / scp のどれでも書ける。href に入るのは github.com の
// リポジトリトップだけなので、ここで https://github.com/<owner>/<repo> に正規化する。
// 他のホスト、ローカルパス、サブパス付きの URL は受け付けない。
export function parseGitHubRemote(value: string): string | null {
  const text = value.trim();
  const url =
    /^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      text,
    );
  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i.exec(text);
  const match = url ?? scp;
  if (match === null) return null;
  const owner = match[1];
  const name = match[2].endsWith(".git") ? match[2].slice(0, -4) : match[2];
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(name)) return null;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return `https://github.com/${owner}/${name}`;
}

function toCount(value: string | undefined): number {
  if (value === undefined) return 0;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function gitStatusLabel(sync: GitSync): string {
  const upstream = sync.upstream;
  if (upstream === null) return "上流ブランチがありません";
  if (sync.ahead === 0 && sync.behind === 0) return `${upstream} と同期しています`;
  if (sync.ahead > 0 && sync.behind > 0) {
    return `${upstream} より ${sync.ahead} コミット進み、${sync.behind} コミット遅れています`;
  }
  if (sync.ahead > 0) return `${upstream} より ${sync.ahead} コミット進んでいます`;
  return `${upstream} より ${sync.behind} コミット遅れています`;
}
