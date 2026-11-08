import { useEffect, useState } from "preact/hooks";
import type { PullRequest } from "../shared/pull-request";
import { readPullRequest } from "./api";
import { isAbortError } from "./chat";

// ブランチが変われば PR も変わる。見出しを開いたときに 1 回だけ引き、引けなければ何も出さない。
// 引き直しの間隔は BFF のキャッシュが持つので、ここではポーリングしない。
export function usePullRequest(workspaceId: string, branch: string | null): PullRequest | null {
  const [entry, setEntry] = useState<{ key: string; pullRequest: PullRequest | null } | null>(null);
  const key = branch === null ? null : `${workspaceId}\n${branch}`;

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    let active = true;
    readPullRequest(workspaceId, controller.signal)
      .then((pullRequest) => {
        if (!active) return;
        setEntry({ key, pullRequest });
      })
      .catch((error) => {
        if (!active || isAbortError(error)) return;
        setEntry({ key, pullRequest: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, workspaceId]);

  // 別のペインやブランチの値を残さない。引けるまでは何も出さない。
  return key !== null && entry !== null && entry.key === key ? entry.pullRequest : null;
}
