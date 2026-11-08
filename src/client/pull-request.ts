import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../server/herdr/state";
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
    readPullRequest(workspaceId, { signal: controller.signal })
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

export const PULL_REQUEST_REFRESH_MS = 30_000;

type PullRequestEntry = { key: string; pullRequest: PullRequest | null };
type PullRequestTarget = { workspaceId: string; branch: string };

function targetKey(target: PullRequestTarget): string {
  return `${target.workspaceId}\n${target.branch}`;
}

function pullRequestTargets(state: AppState | null): PullRequestTarget[] {
  if (state === null) return [];
  return state.workspaces.flatMap((workspace) =>
    workspace.branch === null || workspace.branch === undefined
      ? []
      : [{ workspaceId: workspace.id, branch: workspace.branch }],
  );
}

// 一覧は複数のワークスペースを同時に出す。workspace ごとの値を 1 本の hook にまとめ、
// 可視復帰のときだけ BFF のキャッシュを飛ばして引き直す。ペイン見出しの usePullRequest は
// 1 ワークスペースだけを見るので、そのまま残す。
export function useWorkspacePullRequests(
  state: AppState | null,
): ReadonlyMap<string, PullRequest | null> {
  const targets = pullRequestTargets(state);
  // 並びが変わっただけで引き直さない。対象の集合だけを鍵にする。
  const key = targets.map(targetKey).sort().join("\u0000");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const [entries, setEntries] = useState<ReadonlyMap<string, PullRequestEntry>>(new Map());
  // 直近の完了時刻。可視復帰の連打で gh を起動しないための下限に使う。
  const lastFetchAt = useRef(0);

  useEffect(() => {
    const current = targetsRef.current;
    if (current.length === 0) {
      setEntries((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }

    const controllers = new Map<string, AbortController>();
    let stopped = false;
    let generation = 0;

    const load = async (refresh: boolean) => {
      const request = ++generation;
      const results = await Promise.all(
        current.map(async (target) => {
          const controller = new AbortController();
          controllers.get(target.workspaceId)?.abort();
          controllers.set(target.workspaceId, controller);
          try {
            const pullRequest = await readPullRequest(target.workspaceId, {
              refresh,
              signal: controller.signal,
            });
            return [target.workspaceId, targetKey(target), pullRequest] as const;
          } catch (error) {
            if (isAbortError(error)) return null;
            return [target.workspaceId, targetKey(target), null] as const;
          }
        }),
      );
      // 対象の変更や再取得で追い越された応答は捨てる。
      if (stopped || request !== generation) return;
      lastFetchAt.current = Date.now();
      setEntries((previous) => {
        const next = new Map(previous);
        for (const result of results) {
          if (result !== null) {
            next.set(result[0], { key: result[1], pullRequest: result[2] });
          }
        }
        return next;
      });
    };

    void load(false);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastFetchAt.current < PULL_REQUEST_REFRESH_MS) return;
      void load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      generation += 1;
      for (const controller of controllers.values()) controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key]);

  const result = new Map<string, PullRequest | null>();
  for (const target of targets) {
    const entry = entries.get(target.workspaceId);
    if (entry?.key === targetKey(target)) {
      result.set(target.workspaceId, entry.pullRequest);
    }
  }
  return result;
}
